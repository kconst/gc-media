import { useEffect } from "react";
import { useMap } from "@vis.gl/react-google-maps";
import type { Track, TrailDef } from "@gc-media/shared";

function haversineM(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6_371_000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
}

function distToSegmentM(
  lat: number, lng: number,
  lat1: number, lng1: number,
  lat2: number, lng2: number,
): number {
  const dx = lat2 - lat1;
  const dy = lng2 - lng1;
  const lenSq = dx * dx + dy * dy;
  if (lenSq === 0) return haversineM(lat, lng, lat1, lng1);
  const t = Math.max(0, Math.min(1, ((lat - lat1) * dx + (lng - lng1) * dy) / lenSq));
  return haversineM(lat, lng, lat1 + t * dx, lng1 + t * dy);
}

function distToTrailM(lat: number, lng: number, trail: TrailDef): number {
  let min = Infinity;
  const wps = trail.waypoints;
  for (let i = 0; i < wps.length - 1; i++) {
    const d = distToSegmentM(lat, lng, wps[i]!.lat, wps[i]!.lng, wps[i + 1]!.lat, wps[i + 1]!.lng);
    if (d < min) min = d;
  }
  return min;
}

const THRESHOLD_M = 500;

/** Builds polyline paths for track points that fall within THRESHOLD_M of the trail. */
function matchedSegments(track: Track, trail: TrailDef): google.maps.LatLngLiteral[][] {
  const segs: google.maps.LatLngLiteral[][] = [];
  let cur: google.maps.LatLngLiteral[] = [];
  for (const pt of track.points) {
    if (distToTrailM(pt.lat, pt.lng, trail) <= THRESHOLD_M) {
      cur.push({ lat: pt.lat, lng: pt.lng });
    } else {
      if (cur.length >= 2) segs.push(cur);
      cur = [];
    }
  }
  if (cur.length >= 2) segs.push(cur);
  return segs;
}

/** Longest segment by point count — used for label placement. */
function longestSeg(segs: google.maps.LatLngLiteral[][]): google.maps.LatLngLiteral[] {
  return segs.reduce<google.maps.LatLngLiteral[]>((best, s) => (s.length > best.length ? s : best), []);
}

export function TrailOverlay({
  track,
  trails,
  activeTrails,
}: {
  track: Track;
  trails: TrailDef[];
  activeTrails: Set<string>;
}) {
  const map = useMap();

  useEffect(() => {
    if (!map || activeTrails.size === 0 || track.points.length < 2) return;

    const dispose: Array<{ setMap(m: google.maps.Map | null): void }> = [];

    // Grey out the entire base track so unselected portions visually recede.
    const baseLine = new google.maps.Polyline({
      path: track.points.map((p) => ({ lat: p.lat, lng: p.lng })),
      strokeColor: "#777",
      strokeOpacity: 0.22,
      strokeWeight: 4,
      zIndex: 2,
    });
    baseLine.setMap(map);
    dispose.push(baseLine);

    for (const trail of trails) {
      if (!activeTrails.has(trail.id)) continue;

      const segs = matchedSegments(track, trail);

      for (const seg of segs) {
        const line = new google.maps.Polyline({
          path: seg,
          strokeColor: trail.color,
          strokeOpacity: 0.95,
          strokeWeight: 6,
          zIndex: 3,
        });
        line.setMap(map);
        dispose.push(line);
      }

      // Trail name label at midpoint of the longest matched segment.
      const best = longestSeg(segs);
      if (best.length >= 2) {
        const mid = best[Math.floor(best.length / 2)]!;
        const el = document.createElement("div");
        el.className = "trail-label";
        el.style.setProperty("--tc", trail.color);
        el.textContent = trail.name;

        const marker = new google.maps.marker.AdvancedMarkerElement({
          position: { lat: mid.lat, lng: mid.lng + 0.004 },
          map,
          content: el,
          zIndex: 10,
        });
        dispose.push({ setMap: (m) => { marker.map = m ?? undefined; } });
      }
    }

    return () => dispose.forEach((o) => o.setMap(null));
  }, [map, track, trails, activeTrails]);

  return null;
}
