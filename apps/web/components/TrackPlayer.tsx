"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useMapsLibrary } from "@vis.gl/react-google-maps";
import type { Track } from "@gc-media/shared";

// ── helpers ───────────────────────────────────────────────────────────────────

export function indexAtTime(points: Track["points"], t: number): number {
  if (t <= points[0]!.t) return 0;
  if (t >= points[points.length - 1]!.t) return points.length - 1;
  let lo = 0;
  let hi = points.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (points[mid]!.t < t) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** Linearly interpolate the camera target between the two track points
 * bracketing `t`. Smooths out the jerk you'd get from snapping to discrete
 * GPS samples. */
function interpolatePos(points: Track["points"], t: number) {
  const i = indexAtTime(points, t);
  if (i === 0) return { lat: points[0]!.lat, lng: points[0]!.lng };
  const a = points[i - 1]!;
  const b = points[i]!;
  const span = b.t - a.t;
  const f = span > 0 ? Math.min(1, Math.max(0, (t - a.t) / span)) : 0;
  return { lat: a.lat + (b.lat - a.lat) * f, lng: a.lng + (b.lng - a.lng) * f };
}

/** Local time in the Grand Canyon (Arizona = America/Phoenix, UTC−7, no DST). */
function fmtWallClock(epochMs: number): string {
  const d = new Date(epochMs);
  const date = d.toLocaleDateString("en-US", { timeZone: "America/Phoenix", month: "short", day: "numeric" });
  const time = d.toLocaleTimeString("en-US", { timeZone: "America/Phoenix", hour: "numeric", minute: "2-digit", hour12: true });
  return `${date}  ${time}`;
}

const CAM_TILT = 25;      // degrees from vertical — mostly overhead with a bit of depth
const CAM_HEADING = 0;    // north-up always, no spinning
const CAM_RANGE = 12000;  // metres — far enough to see canyon context

// ── component ─────────────────────────────────────────────────────────────────

interface Props {
  track: Track;
  /**
   * Called each animation frame with the current playback epoch-ms.
   * Called with null when the player is reset to idle.
   */
  onTime: (t: number | null) => void;
}

export function TrackPlayer({ track, onTime }: Props) {
  const lib3d = useMapsLibrary("maps3d") as typeof google.maps.maps3d | null;

  const [isPlaying, setIsPlaying] = useState(false);
  const [progress, setProgress] = useState(0); // 0..1 (UI only)
  const [hasStarted, setHasStarted] = useState(false);
  const [speed, setSpeed] = useState(1); // multiplier relative to 8-min base

  const progressRef = useRef(0);
  const speedRef    = useRef(1);
  const onTimeRef   = useRef(onTime);
  const rafRef      = useRef<number | null>(null);
  const lastRealRef = useRef<number>(0);
  const lastEmitRef = useRef<number>(0);
  const lastPolyRef = useRef<number>(0);
  const map3dHostRef = useRef<HTMLDivElement>(null);
  const el3dRef      = useRef<google.maps.maps3d.Map3DElement | null>(null);
  const poly3dRef    = useRef<google.maps.maps3d.Polyline3DElement | null>(null);
  const path3dRef    = useRef<google.maps.LatLngAltitudeLiteral[]>([]);
  const lastIdx3dRef = useRef<number>(-1);

  useEffect(() => { onTimeRef.current = onTime; }, [onTime]);

  const pts    = track.points;
  const tStart = pts[0]!.t;
  const tSpan  = pts[pts.length - 1]!.t - tStart;

  // Build the 3D map element once the library is ready and the panel is shown.
  // Wait for the custom elements to be defined — constructing them before
  // upgrade silently produces an inert element with no rendering.
  useEffect(() => {
    if (!lib3d || !map3dHostRef.current || !hasStarted) return;
    path3dRef.current = pts.map((p) => ({ lat: p.lat, lng: p.lng, altitude: 0 }));

    let cancelled = false;
    let el: google.maps.maps3d.Map3DElement | null = null;
    let bgPoly: google.maps.maps3d.Polyline3DElement | null = null;
    let poly: google.maps.maps3d.Polyline3DElement | null = null;
    const host = map3dHostRef.current;

    (async () => {
      await Promise.all([
        customElements.whenDefined("gmp-map-3d"),
        customElements.whenDefined("gmp-polyline-3d"),
      ]);
      if (cancelled) return;

      const pt0 = pts[0]!;
      el = new lib3d.Map3DElement({
        center: { lat: pt0.lat, lng: pt0.lng, altitude: 0 },
        tilt: CAM_TILT,
        range: CAM_RANGE,
        heading: CAM_HEADING,
        mode: "HYBRID" as google.maps.maps3d.MapMode,
      });
      el.style.width = "100%";
      el.style.height = "100%";
      host.appendChild(el);
      el3dRef.current = el;

      // Faint full-track outline so the route is visible from the start.
      bgPoly = new lib3d.Polyline3DElement({
        coordinates: path3dRef.current,
        strokeColor: "rgba(255,255,255,0.7)",
        strokeWidth: 4,
        altitudeMode: "CLAMP_TO_GROUND" as google.maps.maps3d.AltitudeMode,
      });
      el.append(bgPoly);

      // Played portion grows on top. Start with the first two points so the
      // element has a non-degenerate path to render.
      const initIdx = Math.min(1, pts.length - 1);
      poly = new lib3d.Polyline3DElement({
        coordinates: path3dRef.current.slice(0, initIdx + 1),
        strokeColor: "#1a73e8",
        strokeWidth: 12,
        altitudeMode: "CLAMP_TO_GROUND" as google.maps.maps3d.AltitudeMode,
      });
      el.append(poly);
      poly3dRef.current = poly;
      lastIdx3dRef.current = initIdx;
    })();

    return () => {
      cancelled = true;
      poly?.remove();
      bgPoly?.remove();
      el?.remove();
      poly3dRef.current = null;
      el3dRef.current = null;
    };
  }, [lib3d, pts, hasStarted]);

  /** Move the 3D camera smoothly to the interpolated track position; grow
   *  the played polyline when the underlying track-point index advances. */
  function update3d(p: number, now: number) {
    const t = tStart + p * tSpan;
    const el = el3dRef.current;
    if (el) {
      const pos = interpolatePos(pts, t);
      // Direct assignment moves the camera in one frame, with no animation
      // queueing — combined with our 60fps animate loop this looks smooth.
      el.center = { lat: pos.lat, lng: pos.lng, altitude: 0 };
    }
    // The polyline doesn't need 60fps; update it ~5 times per second when
    // the bracketing track-point index has advanced.
    if (now - lastPolyRef.current < 200) return;
    lastPolyRef.current = now;
    const poly = poly3dRef.current;
    if (!poly) return;
    const idx = Math.max(1, indexAtTime(pts, t));
    if (idx === lastIdx3dRef.current) return;
    poly.coordinates = path3dRef.current.slice(0, idx + 1);
    lastIdx3dRef.current = idx;
  }

  // Animation loop — full track plays in ~8 minutes at 1×, scaled by speedRef.
  // setProgress runs every frame for a smooth scrubber. onTime is throttled to
  // 200 ms so the clusterer doesn't churn 60×/sec and cause pin flicker.
  const animate = useCallback(
    (now: number) => {
      const dt = now - lastRealRef.current;
      lastRealRef.current = now;
      const next = Math.min(1, progressRef.current + dt * speedRef.current / (8 * 60 * 1000));
      progressRef.current = next;
      setProgress(next);
      if (next >= 1 || now - lastEmitRef.current >= 200) {
        lastEmitRef.current = now;
        onTimeRef.current(tStart + next * tSpan);
      }
      update3d(next, now);
      if (next >= 1) {
        setIsPlaying(false);
        return;
      }
      rafRef.current = requestAnimationFrame(animate);
    },
    // update3d reads from refs; safe to omit from deps.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [tStart, tSpan],
  );

  useEffect(() => {
    if (isPlaying) {
      lastRealRef.current = performance.now();
      rafRef.current = requestAnimationFrame(animate);
    } else {
      if (rafRef.current !== null) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
    }
    return () => { if (rafRef.current !== null) cancelAnimationFrame(rafRef.current); };
  }, [isPlaying, animate]);

  function handlePlay() {
    if (progress >= 1) {
      progressRef.current = 0;
      setProgress(0);
      if (poly3dRef.current) {
        const initIdx = Math.min(1, pts.length - 1);
        poly3dRef.current.coordinates = path3dRef.current.slice(0, initIdx + 1);
        lastIdx3dRef.current = initIdx;
      }
    }
    // Emit synchronously so the pin filter activates in the same render
    // batch as setIsPlaying — no flash of "all pins visible" while we wait
    // for the first animation frame.
    onTimeRef.current(tStart + progressRef.current * tSpan);
    lastEmitRef.current = performance.now();
    setHasStarted(true);
    setIsPlaying(true);
  }

  function handlePause() {
    setIsPlaying(false);
  }

  function handleReset() {
    if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
    rafRef.current = null;
    setIsPlaying(false);
    setHasStarted(false);
    progressRef.current = 0;
    setProgress(0);
    onTimeRef.current(null);
  }

  function handleSpeed(s: number) {
    speedRef.current = s;
    setSpeed(s);
    if (isPlaying) lastRealRef.current = performance.now();
  }

  function handleScrub(e: React.ChangeEvent<HTMLInputElement>) {
    const p = Number(e.target.value) / 10000;
    progressRef.current = p;
    setProgress(p);
    setHasStarted(true);
    onTimeRef.current(tStart + p * tSpan);
    update3d(p, performance.now());
    if (isPlaying) lastRealRef.current = performance.now();
  }

  const currentEpoch = tStart + progress * tSpan;

  return createPortal(
    <>
      <div className="player-bar">
        {isPlaying ? (
          <button className="player-btn" onClick={handlePause} aria-label="Pause">⏸</button>
        ) : (
          <button className="player-btn" onClick={handlePlay} aria-label="Play">▶</button>
        )}
        <span className="player-time" title="Time of day at the current track position">
          {fmtWallClock(currentEpoch)}
        </span>
        <input
          type="range"
          className="player-scrubber"
          min={0}
          max={10000}
          value={Math.round(progress * 10000)}
          onChange={handleScrub}
        />
        <div className="player-speeds">
          {([1, 2, 4] as const).map((s) => (
            <button
              key={s}
              className={`player-speed-btn${speed === s ? " on" : ""}`}
              onClick={() => handleSpeed(s)}
            >{s}×</button>
          ))}
        </div>
        <button className="player-btn player-btn-reset" onClick={handleReset} title="Reset">↺</button>
      </div>

      {hasStarted && (
        <div className="player-3d">
          {!lib3d && <div className="map3d-msg">Loading 3D…</div>}
          <div ref={map3dHostRef} style={{ width: "100%", height: "100%" }} />
        </div>
      )}
    </>,
    document.body,
  );
}
