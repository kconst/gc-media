import fs from "node:fs/promises";
import path from "node:path";
import type { TrackPoint } from "@gc-media/shared";

/** Great-circle distance between two fixes, in metres. */
function haversineMeters(a: TrackPoint, b: TrackPoint): number {
  const R = 6_371_000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Parse <trkpt> points (lat/lon, <time>, optional heart rate) out of GPX XML. */
export function parseGpx(xml: string): TrackPoint[] {
  const out: TrackPoint[] = [];
  const trkptRe = /<trkpt\b([^>]*)>([\s\S]*?)<\/trkpt>/gi;
  const latRe = /\blat="([-\d.]+)"/i;
  const lonRe = /\blon="([-\d.]+)"/i;
  const timeRe = /<time>([^<]+)<\/time>/i;
  // Heart rate lives in a Garmin TrackPointExtension; the namespace prefix
  // varies (gpxtpx:hr, ns3:hr, plain hr), so match any prefix.
  const hrRe = /<(?:\w+:)?hr>(\d+)<\/(?:\w+:)?hr>/i;

  let m: RegExpExecArray | null;
  while ((m = trkptRe.exec(xml))) {
    const attrs = m[1]!;
    const inner = m[2]!;
    const lat = parseFloat(latRe.exec(attrs)?.[1] ?? "");
    const lng = parseFloat(lonRe.exec(attrs)?.[1] ?? "");
    const ts = timeRe.exec(inner)?.[1];
    const t = ts ? Date.parse(ts) : NaN;
    if (!Number.isFinite(lat) || !Number.isFinite(lng) || !Number.isFinite(t)) continue;
    const point: TrackPoint = { lat, lng, t };
    const hr = hrRe.exec(inner)?.[1];
    if (hr) point.hr = Number(hr);
    out.push(point);
  }

  out.sort((a, b) => a.t - b.t);
  fillSpeed(out);
  return out;
}

/** Derive ground speed (m/s) for each point from the previous fix. */
function fillSpeed(points: TrackPoint[]): void {
  for (let i = 1; i < points.length; i++) {
    const prev = points[i - 1]!;
    const cur = points[i]!;
    const dt = (cur.t - prev.t) / 1000;
    if (dt > 0) cur.speed = haversineMeters(prev, cur) / dt;
  }
  if (points.length > 1) points[0]!.speed = points[1]!.speed;
}

async function* walk(dir: string): AsyncGenerator<string> {
  let entries: import("node:fs").Dirent[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(full);
    else if (entry.isFile() && entry.name.toLowerCase().endsWith(".gpx")) yield full;
  }
}

/** Load every .gpx track under `dir` (recursively), merged and time-sorted. */
export async function loadGpxTracks(dir: string): Promise<TrackPoint[]> {
  const points: TrackPoint[] = [];
  for await (const file of walk(dir)) {
    try {
      points.push(...parseGpx(await fs.readFile(file, "utf8")));
    } catch {
      // Skip unreadable/invalid GPX.
    }
  }
  points.sort((a, b) => a.t - b.t);
  return points;
}
