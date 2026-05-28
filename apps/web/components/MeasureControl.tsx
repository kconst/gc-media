import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useMap } from "@vis.gl/react-google-maps";
import type { Asset, Track, TrackPoint } from "@gc-media/shared";

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
  media: number;
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
  const media = assets.filter((a) => {
    const t = a.capturedAt ? Date.parse(a.capturedAt) : NaN;
    return Number.isFinite(t) && t >= t0 && t <= t1;
  }).length;
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

export function MeasureControl({ track, assets }: { track?: Track; assets: Asset[] }) {
  const map = useMap();
  const overlayRef = useRef<google.maps.OverlayView | null>(null);
  const segLineRef = useRef<google.maps.Polyline | null>(null);
  const [active, setActive] = useState(false);
  const [stroke, setStroke] = useState<{ x: number; y: number }[]>([]);
  const drawing = useRef(false);
  const [stats, setStats] = useState<Stats | null>(null);
  const [bubble, setBubble] = useState<{ x: number; y: number } | null>(null);

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
    // highlight the matched segment on the map
    clearSeg();
    segLineRef.current = new google.maps.Polyline({
      path: tp.slice(lo, hi + 1).map((p) => ({ lat: p.lat, lng: p.lng })),
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
            <dt>Photos/videos</dt><dd>{stats.media}</dd>
          </dl>
        </div>
      )}
    </>,
    document.body,
  );
}
