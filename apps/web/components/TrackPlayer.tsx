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

/** Local time in the Grand Canyon (Arizona = America/Phoenix, UTC−7, no DST). */
function fmtWallClock(epochMs: number): string {
  const d = new Date(epochMs);
  const date = d.toLocaleDateString("en-US", { timeZone: "America/Phoenix", month: "short", day: "numeric" });
  const time = d.toLocaleTimeString("en-US", { timeZone: "America/Phoenix", hour: "numeric", minute: "2-digit", hour12: true });
  return `${date}  ${time}`;
}

const CAM_TILT = 60;      // degrees from vertical — shows terrain depth
const CAM_HEADING = 0;   // north-up always, no spinning
const CAM_RANGE = 2500;  // metres — close enough to see canyon walls

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
  useEffect(() => {
    if (!lib3d || !map3dHostRef.current || !hasStarted) return;
    // Precompute the full 3D path; we slice into it as playback advances.
    path3dRef.current = pts.map((p) => ({ lat: p.lat, lng: p.lng, altitude: 0 }));

    const pt0 = pts[0]!;
    const el = new lib3d.Map3DElement({
      center: { lat: pt0.lat, lng: pt0.lng, altitude: 0 },
      tilt: CAM_TILT,
      range: CAM_RANGE,
      heading: CAM_HEADING,
      mode: "HYBRID" as google.maps.maps3d.MapMode,
    });
    el.style.width = "100%";
    el.style.height = "100%";
    map3dHostRef.current.appendChild(el);
    el3dRef.current = el;

    // Faint full track as background so the route is visible from the start.
    const bgPoly = new lib3d.Polyline3DElement({
      coordinates: path3dRef.current,
      strokeColor: "rgba(255,255,255,0.45)",
      strokeWidth: 4,
      altitudeMode: "CLAMP_TO_GROUND" as google.maps.maps3d.AltitudeMode,
    });
    el.append(bgPoly);

    // Played portion grows on top. Start with the first two points so the
    // element has a non-degenerate path to render.
    const initIdx = Math.min(1, pts.length - 1);
    const poly = new lib3d.Polyline3DElement({
      coordinates: path3dRef.current.slice(0, initIdx + 1),
      strokeColor: "#1a73e8",
      strokeWidth: 10,
      altitudeMode: "CLAMP_TO_GROUND" as google.maps.maps3d.AltitudeMode,
    });
    el.append(poly);
    poly3dRef.current = poly;
    lastIdx3dRef.current = initIdx;

    return () => {
      poly.remove();
      bgPoly.remove();
      el.remove();
      poly3dRef.current = null;
      el3dRef.current = null;
    };
  }, [lib3d, pts, hasStarted]);

  function update3d(p: number) {
    const idx = Math.max(1, indexAtTime(pts, tStart + p * tSpan));
    const poly = poly3dRef.current;
    if (poly && idx !== lastIdx3dRef.current) {
      poly.coordinates = path3dRef.current.slice(0, idx + 1);
      lastIdx3dRef.current = idx;
    }
    const el = el3dRef.current;
    if (el) {
      const pt = pts[idx]!;
      el.flyCameraTo({
        endCamera: {
          center: { lat: pt.lat, lng: pt.lng, altitude: 0 },
          tilt: CAM_TILT,
          range: CAM_RANGE,
          heading: CAM_HEADING,
        },
        durationMillis: 900,
      });
    }
  }

  // Animation loop — full track plays in ~8 minutes at 1×, scaled by speedRef.
  // setProgress runs every frame for a smooth scrubber. onTime is throttled to
  // 200 ms so the clusterer doesn't churn 60×/sec and cause flicker.
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
      if (next >= 1) {
        setIsPlaying(false);
        return;
      }
      rafRef.current = requestAnimationFrame(animate);
    },
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

  // Grow the 3D polyline ~5×/sec while playing.
  useEffect(() => {
    if (!isPlaying) return;
    const id = setInterval(() => update3d(progressRef.current), 200);
    return () => clearInterval(id);
  // update3d reads from refs; eslint would want it in deps but it's stable.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isPlaying]);

  function handlePlay() {
    if (progress >= 1) {
      progressRef.current = 0;
      setProgress(0);
      onTimeRef.current(tStart);
      if (poly3dRef.current) {
        const initIdx = Math.min(1, pts.length - 1);
        poly3dRef.current.coordinates = path3dRef.current.slice(0, initIdx + 1);
        lastIdx3dRef.current = initIdx;
      }
    }
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
    update3d(p);
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
