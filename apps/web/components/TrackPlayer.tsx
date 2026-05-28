"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useMapsLibrary } from "@vis.gl/react-google-maps";
import type { Track } from "@gc-media/shared";

// ── helpers ───────────────────────────────────────────────────────────────────

function bearing(
  a: { lat: number; lng: number },
  b: { lat: number; lng: number },
): number {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const toDeg = (r: number) => (r * 180) / Math.PI;
  const dLng = toRad(b.lng - a.lng);
  const y = Math.sin(dLng) * Math.cos(toRad(b.lat));
  const x =
    Math.cos(toRad(a.lat)) * Math.sin(toRad(b.lat)) -
    Math.sin(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.cos(dLng);
  return (toDeg(Math.atan2(y, x)) + 360) % 360;
}

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

function fmtMs(ms: number): string {
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return h > 0
    ? `${h}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`
    : `${m}:${String(sec).padStart(2, "0")}`;
}

const CAM_ALT = 2000;  // metres above track elevation
const CAM_TILT = 30;
const CAM_RANGE = 3500;

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

  const progressRef = useRef(0);
  const onTimeRef   = useRef(onTime);
  const rafRef      = useRef<number | null>(null);
  const lastRealRef = useRef<number>(0);
  const map3dHostRef = useRef<HTMLDivElement>(null);
  const el3dRef      = useRef<google.maps.maps3d.Map3DElement | null>(null);

  useEffect(() => { onTimeRef.current = onTime; }, [onTime]);

  const pts    = track.points;
  const tStart = pts[0]!.t;
  const tSpan  = pts[pts.length - 1]!.t - tStart;

  // Build the 3D map element once the library is ready and the panel is shown.
  useEffect(() => {
    if (!lib3d || !map3dHostRef.current || !hasStarted) return;
    const pt0 = pts[0]!;
    const pt1 = pts[1] ?? pt0;
    const el = new lib3d.Map3DElement({
      center: { lat: pt0.lat, lng: pt0.lng, altitude: (pt0.ele ?? 1500) + CAM_ALT },
      tilt: CAM_TILT,
      range: CAM_RANGE,
      heading: bearing(pt0, pt1),
      mode: "HYBRID" as google.maps.maps3d.MapMode,
    });
    el.style.width = "100%";
    el.style.height = "100%";
    map3dHostRef.current.appendChild(el);
    el3dRef.current = el;
    return () => {
      el.remove();
      el3dRef.current = null;
    };
  }, [lib3d, pts, hasStarted]);

  function flyCamera(p: number) {
    const el = el3dRef.current;
    if (!el) return;
    const idx = indexAtTime(pts, tStart + p * tSpan);
    const pt  = pts[idx]!;
    const nxt = pts[Math.min(idx + 1, pts.length - 1)]!;
    el.flyCameraTo({
      endCamera: {
        center: { lat: pt.lat, lng: pt.lng, altitude: (pt.ele ?? 1500) + CAM_ALT },
        tilt: CAM_TILT,
        range: CAM_RANGE,
        heading: bearing(pt, nxt),
      },
      durationMillis: 800,
    });
  }

  // Animation loop — full track plays in ~3 minutes real time.
  const animate = useCallback(
    (now: number) => {
      const dt = now - lastRealRef.current;
      lastRealRef.current = now;
      const next = Math.min(1, progressRef.current + dt / (3 * 60 * 1000));
      progressRef.current = next;
      setProgress(next);
      onTimeRef.current(tStart + next * tSpan);
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

  // Update 3D camera every 700 ms while playing.
  useEffect(() => {
    if (!isPlaying) return;
    const id = setInterval(() => flyCamera(progressRef.current), 700);
    return () => clearInterval(id);
  // flyCamera reads from refs; eslint would want it in deps but it's stable.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isPlaying]);

  function handlePlay() {
    if (progress >= 1) {
      progressRef.current = 0;
      setProgress(0);
      onTimeRef.current(tStart);
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

  function handleScrub(e: React.ChangeEvent<HTMLInputElement>) {
    const p = Number(e.target.value) / 10000;
    progressRef.current = p;
    setProgress(p);
    setHasStarted(true);
    onTimeRef.current(tStart + p * tSpan);
    flyCamera(p);
    if (isPlaying) lastRealRef.current = performance.now();
  }

  return createPortal(
    <>
      <div className="player-bar">
        {isPlaying ? (
          <button className="player-btn" onClick={handlePause} aria-label="Pause">⏸</button>
        ) : (
          <button className="player-btn" onClick={handlePlay} aria-label="Play">▶</button>
        )}
        <span className="player-time">{fmtMs(progress * tSpan)}</span>
        <input
          type="range"
          className="player-scrubber"
          min={0}
          max={10000}
          value={Math.round(progress * 10000)}
          onChange={handleScrub}
        />
        <span className="player-time">{fmtMs(tSpan)}</span>
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
