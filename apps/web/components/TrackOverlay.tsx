import { useEffect } from "react";
import { useMap } from "@vis.gl/react-google-maps";
import type { Track, TrackPoint } from "@gc-media/shared";

export type TrackMetric = "speed" | "hr";

const value = (p: TrackPoint, metric: TrackMetric): number | undefined =>
  metric === "hr" ? p.hr : p.speed;

/** Blue (low) → green → red (high). */
function rampColor(f: number): string {
  const hue = (1 - Math.max(0, Math.min(1, f))) * 240; // 240=blue, 0=red
  return `hsl(${hue}, 85%, 50%)`;
}

/** Robust [min,max] over defined values, clamped to the 2nd/98th percentile. */
export function metricDomain(points: TrackPoint[], metric: TrackMetric): [number, number] | null {
  const vals = points
    .map((p) => value(p, metric))
    .filter((v): v is number => v !== undefined)
    .sort((a, b) => a - b);
  if (vals.length < 2) return null;
  const at = (q: number) => vals[Math.min(vals.length - 1, Math.floor(q * (vals.length - 1)))]!;
  const lo = at(0.02);
  const hi = at(0.98);
  return hi > lo ? [lo, hi] : null;
}

const BANDS = 24;

/**
 * Draw the track as a sequence of polylines, one per run of points sharing a
 * quantised colour band. This keeps the overlay to a few dozen Polyline
 * objects instead of one per segment.
 */
function buildSegments(
  points: TrackPoint[],
  metric: TrackMetric,
  domain: [number, number],
): google.maps.Polyline[] {
  const [lo, hi] = domain;
  const band = (p: TrackPoint) => {
    const v = value(p, metric);
    if (v === undefined) return -1;
    return Math.max(0, Math.min(BANDS - 1, Math.floor(((v - lo) / (hi - lo)) * BANDS)));
  };

  const lines: google.maps.Polyline[] = [];
  let path: google.maps.LatLngLiteral[] = [];
  let curBand = band(points[0]!);

  const flush = () => {
    if (path.length >= 2 && curBand >= 0) {
      lines.push(
        new google.maps.Polyline({
          path,
          geodesic: true,
          strokeColor: rampColor(curBand / (BANDS - 1)),
          strokeOpacity: 0.95,
          strokeWeight: 4,
          zIndex: 1,
        }),
      );
    }
  };

  for (const p of points) {
    const b = band(p);
    const ll = { lat: p.lat, lng: p.lng };
    if (b !== curBand) {
      path.push(ll); // include the boundary point so segments stay connected
      flush();
      curBand = b;
      path = [ll];
    } else {
      path.push(ll);
    }
  }
  flush();
  return lines;
}

export function TrackOverlay({ track, metric }: { track: Track; metric: TrackMetric }) {
  const map = useMap();

  useEffect(() => {
    if (!map || track.points.length < 2) return;
    const domain = metricDomain(track.points, metric);
    if (!domain) return;
    const lines = buildSegments(track.points, metric, domain);
    lines.forEach((l) => l.setMap(map));
    return () => lines.forEach((l) => l.setMap(null));
  }, [map, track, metric]);

  return null;
}
