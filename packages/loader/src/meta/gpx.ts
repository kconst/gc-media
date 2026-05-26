import fs from "node:fs/promises";
import path from "node:path";
import type { GpsSample } from "../types.js";

/** Parse <trkpt> points (lat/lon + <time>) out of GPX XML into GPS samples. */
export function parseGpx(xml: string): GpsSample[] {
  const out: GpsSample[] = [];
  const trkptRe = /<trkpt\b([^>]*)>([\s\S]*?)<\/trkpt>/gi;
  const latRe = /\blat="([-\d.]+)"/i;
  const lonRe = /\blon="([-\d.]+)"/i;
  const timeRe = /<time>([^<]+)<\/time>/i;

  let m: RegExpExecArray | null;
  while ((m = trkptRe.exec(xml))) {
    const attrs = m[1]!;
    const inner = m[2]!;
    const lat = parseFloat(latRe.exec(attrs)?.[1] ?? "");
    const lng = parseFloat(lonRe.exec(attrs)?.[1] ?? "");
    const ts = timeRe.exec(inner)?.[1];
    const t = ts ? Date.parse(ts) : NaN;
    if (Number.isFinite(lat) && Number.isFinite(lng) && Number.isFinite(t)) {
      out.push({ t, lat, lng });
    }
  }
  return out;
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

/** Load every .gpx track under `dir` (recursively) into one set of samples. */
export async function loadGpxTracks(dir: string): Promise<GpsSample[]> {
  const samples: GpsSample[] = [];
  for await (const file of walk(dir)) {
    try {
      samples.push(...parseGpx(await fs.readFile(file, "utf8")));
    } catch {
      // Skip unreadable/invalid GPX.
    }
  }
  return samples;
}
