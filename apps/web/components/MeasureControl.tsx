import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useMap, useMapsLibrary } from "@vis.gl/react-google-maps";
import type { Asset, Track, TrackPoint } from "@gc-media/shared";

interface Center {
  lat: number;
  lng: number;
  alt: number;
}

/** Compass bearing (deg) from a → b. */
function bearing(a: Center, b: Center): number {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const toDeg = (r: number) => (r * 180) / Math.PI;
  const dLng = toRad(b.lng - a.lng);
  const y = Math.sin(dLng) * Math.cos(toRad(b.lat));
  const x =
    Math.cos(toRad(a.lat)) * Math.sin(toRad(b.lat)) -
    Math.sin(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.cos(dLng);
  return (toDeg(Math.atan2(y, x)) + 360) % 360;
}

/** Photorealistic 3D map that flies the camera along the segment's path. */
function Map3DView({ path, onClose }: { path: Center[]; onClose: () => void }) {
  const lib = useMapsLibrary("maps3d") as typeof google.maps.maps3d | null;
  const hostRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!lib || !hostRef.current || path.length < 2) return;
    const heading0 = bearing(path[0]!, path[1]!);
    const el = new lib.Map3DElement({
      center: { lat: path[0]!.lat, lng: path[0]!.lng, altitude: path[0]!.alt },
      tilt: 65,
      range: 1200,
      heading: heading0,
      mode: "HYBRID" as google.maps.maps3d.MapMode,
    });
    el.style.width = "100%";
    el.style.height = "100%";
    hostRef.current.appendChild(el);

    let stop = false;
    let i = 0;
    const step = () => {
      if (stop) return;
      i = (i + 1) % path.length;
      const cur = path[i]!;
      const nxt = path[(i + 1) % path.length]!;
      el.flyCameraTo({
        endCamera: {
          center: { lat: cur.lat, lng: cur.lng, altitude: cur.alt },
          tilt: 65,
          range: 1200,
          heading: bearing(cur, nxt),
        },
        durationMillis: 2600,
      });
    };
    el.addEventListener("gmp-animationend", step);
    const t = setTimeout(step, 700);
    return () => {
      stop = true;
      clearTimeout(t);
      el.remove();
    };
  }, [lib, path]);

  return (
    <div className="map3d-panel">
      <button className="x" onClick={onClose} aria-label="Close 3D view">×</button>
      {!lib && <div className="map3d-msg">Loading 3D…</div>}
      <div ref={hostRef} className="map3d-canvas" />
    </div>
  );
}

const M_TO_MI = 1 / 1609.344;
const MPS_TO_MPH = 2.23694;
const M_TO_FT = 3.28084;

function haversine(a: TrackPoint, b: TrackPoint): number {
  const R = 6_371_000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

interface Stats {
  durationMs: number;
  distM: number;
  avgMph: number;
  maxMph: number;
  avgHr?: number;
  maxHr?: number;
  gainFt?: number;
  lossFt?: number;
  media: Asset[];
}

function computeSegment(pts: TrackPoint[], i0: number, i1: number, assets: Asset[]): Stats {
  const seg = pts.slice(i0, i1 + 1);
  const t0 = seg[0]!.t;
  const t1 = seg[seg.length - 1]!.t;
  let distM = 0;
  let maxSpeed = 0;
  let hrSum = 0;
  let hrN = 0;
  let maxHr = 0;
  let gain = 0;
  let loss = 0;
  let hasEle = false;
  for (let i = 0; i < seg.length; i++) {
    const p = seg[i]!;
    if (i > 0) distM += haversine(seg[i - 1]!, p);
    if (p.speed && p.speed > maxSpeed) maxSpeed = p.speed;
    if (p.hr !== undefined) {
      hrSum += p.hr;
      hrN++;
      if (p.hr > maxHr) maxHr = p.hr;
    }
    if (i > 0 && p.ele !== undefined && seg[i - 1]!.ele !== undefined) {
      hasEle = true;
      const d = p.ele - seg[i - 1]!.ele!;
      if (d > 0) gain += d;
      else loss += -d;
    }
  }
  const durS = Math.max(1, (t1 - t0) / 1000);
  const media = assets
    .filter((a) => {
      const t = a.capturedAt ? Date.parse(a.capturedAt) : NaN;
      return Number.isFinite(t) && t >= t0 && t <= t1;
    })
    .sort((a, b) => (a.capturedAt ?? "").localeCompare(b.capturedAt ?? ""));
  return {
    durationMs: t1 - t0,
    distM,
    avgMph: (distM / durS) * MPS_TO_MPH,
    maxMph: maxSpeed * MPS_TO_MPH,
    avgHr: hrN ? Math.round(hrSum / hrN) : undefined,
    maxHr: hrN ? maxHr : undefined,
    gainFt: hasEle ? Math.round(gain * M_TO_FT) : undefined,
    lossFt: hasEle ? Math.round(loss * M_TO_FT) : undefined,
    media,
  };
}

function fmtDur(ms: number): string {
  const s = Math.round(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return h ? `${h}h ${m}m` : m ? `${m}m ${sec}s` : `${sec}s`;
}

export function MeasureControl({
  track,
  assets,
  onSelect,
}: {
  track?: Track;
  assets: Asset[];
  onSelect: (a: Asset) => void;
}) {
  const map = useMap();
  const overlayRef = useRef<google.maps.OverlayView | null>(null);
  const segLineRef = useRef<google.maps.Polyline | null>(null);
  const [active, setActive] = useState(false);
  const [stroke, setStroke] = useState<{ x: number; y: number }[]>([]);
  const drawing = useRef(false);
  const [stats, setStats] = useState<Stats | null>(null);
  const [bubble, setBubble] = useState<{ x: number; y: number } | null>(null);
  const [flyPath, setFlyPath] = useState<Center[] | null>(null);

  // An OverlayView gives us the pixel<->latLng projection.
  useEffect(() => {
    if (!map || overlayRef.current) return;
    const ov = new google.maps.OverlayView();
    ov.onAdd = () => {};
    ov.draw = () => {};
    ov.onRemove = () => {};
    ov.setMap(map);
    overlayRef.current = ov;
    return () => ov.setMap(null);
  }, [map]);

  function clearSeg() {
    segLineRef.current?.setMap(null);
    segLineRef.current = null;
  }

  function finish(points: { x: number; y: number }[]) {
    const proj = overlayRef.current?.getProjection();
    if (!proj || !map || !track || points.length < 2) {
      setStroke([]);
      return;
    }
    const rect = map.getDiv().getBoundingClientRect();
    const tp = track.points;
    let lo = Infinity;
    let hi = -Infinity;
    for (const s of points) {
      const ll = proj.fromContainerPixelToLatLng(new google.maps.Point(s.x - rect.left, s.y - rect.top));
      if (!ll) continue;
      const lat = ll.lat();
      const lng = ll.lng();
      let best = -1;
      let bd = Infinity;
      for (let i = 0; i < tp.length; i++) {
        const dy = tp[i]!.lat - lat;
        const dx = tp[i]!.lng - lng;
        const d = dx * dx + dy * dy;
        if (d < bd) {
          bd = d;
          best = i;
        }
      }
      if (best >= 0) {
        if (best < lo) lo = best;
        if (best > hi) hi = best;
      }
    }
    setStroke([]);
    if (hi <= lo) return;
    setStats(computeSegment(tp, lo, hi, assets));
    setBubble(points[points.length - 1]!);

    // Build a downsampled flythrough path (~36 waypoints) for the 3D view.
    const seg = tp.slice(lo, hi + 1);
    const MAX_WP = 36;
    const stepN = Math.max(1, Math.floor(seg.length / MAX_WP));
    const wp: Center[] = [];
    for (let i = 0; i < seg.length; i += stepN) {
      wp.push({ lat: seg[i]!.lat, lng: seg[i]!.lng, alt: seg[i]!.ele ?? 0 });
    }
    const last = seg[seg.length - 1]!;
    wp.push({ lat: last.lat, lng: last.lng, alt: last.ele ?? 0 });
    setFlyPath(wp.length >= 2 ? wp : null);

    // highlight the matched segment on the map
    clearSeg();
    segLineRef.current = new google.maps.Polyline({
      path: seg.map((p) => ({ lat: p.lat, lng: p.lng })),
      strokeColor: "#ff3b30",
      strokeOpacity: 0.9,
      strokeWeight: 6,
      zIndex: 5,
      map,
    });
  }

  function close() {
    setStats(null);
    setBubble(null);
    setFlyPath(null);
    clearSeg();
  }

  if (!track || track.points.length < 2) return null;

  return createPortal(
    <>
      <div className="measure-ctl">
        <button
          className={active ? "on" : ""}
          onClick={() => {
            setActive((a) => !a);
            close();
          }}
        >
          {active ? "Drawing… tap to exit" : "📏 Measure segment"}
        </button>
      </div>

      {active && (
        <div
          className="measure-layer"
          onPointerDown={(e) => {
            drawing.current = true;
            close();
            setStroke([{ x: e.clientX, y: e.clientY }]);
          }}
          onPointerMove={(e) => {
            if (drawing.current) setStroke((p) => [...p, { x: e.clientX, y: e.clientY }]);
          }}
          onPointerUp={() => {
            if (!drawing.current) return;
            drawing.current = false;
            setStroke((p) => {
              finish(p);
              return p;
            });
          }}
        >
          {stroke.length > 1 && (
            <svg>
              <polyline points={stroke.map((p) => `${p.x},${p.y}`).join(" ")} />
            </svg>
          )}
        </div>
      )}

      {stats && bubble && (
        <div
          className="measure-bubble"
          style={{ left: Math.min(bubble.x + 14, window.innerWidth - 200), top: Math.max(12, bubble.y - 150) }}
        >
          <button className="x" onClick={close} aria-label="Close">×</button>
          <h4>Segment</h4>
          <dl>
            <dt>Duration</dt><dd>{fmtDur(stats.durationMs)}</dd>
            <dt>Distance</dt><dd>{(stats.distM * M_TO_MI).toFixed(2)} mi</dd>
            <dt>Avg speed</dt><dd>{stats.avgMph.toFixed(1)} mph</dd>
            <dt>Max speed</dt><dd>{stats.maxMph.toFixed(1)} mph</dd>
            {stats.avgHr !== undefined && (<><dt>Avg HR</dt><dd>{stats.avgHr} bpm</dd></>)}
            {stats.maxHr !== undefined && (<><dt>Max HR</dt><dd>{stats.maxHr} bpm</dd></>)}
            {stats.gainFt !== undefined && (<><dt>Elev gain</dt><dd>+{stats.gainFt} ft</dd></>)}
            {stats.lossFt !== undefined && (<><dt>Elev loss</dt><dd>−{stats.lossFt} ft</dd></>)}
            <dt>Photos/videos</dt><dd>{stats.media.length}</dd>
          </dl>
          {stats.media.length > 0 && (
            <div className="measure-thumbs">
              {stats.media.map((a) => (
                <img
                  key={a.id}
                  src={a.thumbnailUrl}
                  title={`${a.type}${a.capturedAt ? " · " + a.capturedAt.slice(11, 16) : ""}`}
                  className={a.type === "video" ? "vid" : ""}
                  onClick={() => onSelect(a)}
                />
              ))}
            </div>
          )}
        </div>
      )}

      {flyPath && <Map3DView path={flyPath} onClose={close} />}
    </>,
    document.body,
  );
}
