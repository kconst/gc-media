import fs from "node:fs/promises";
import path from "node:path";
import type { GeoPoint } from "@gc-media/shared";

export interface TakeoutMeta {
  gps?: GeoPoint;
  /** Capture time as epoch ms (UTC), when present. */
  capturedAt?: number;
}

interface RawGeo {
  latitude?: number;
  longitude?: number;
}

interface RawSidecar {
  geoData?: RawGeo;
  geoDataExif?: RawGeo;
  photoTakenTime?: { timestamp?: string };
  creationTime?: { timestamp?: string };
}

/** Cache of *.json filenames per directory so we scan each folder once. */
const dirJsonCache = new Map<string, string[]>();

async function jsonFilesIn(dir: string): Promise<string[]> {
  const cached = dirJsonCache.get(dir);
  if (cached) return cached;
  let files: string[];
  try {
    files = (await fs.readdir(dir)).filter((f) => f.toLowerCase().endsWith(".json"));
  } catch {
    files = [];
  }
  dirJsonCache.set(dir, files);
  return files;
}

/**
 * Exact sidecar names Takeout produces for a media file. Newer exports use
 * "<name>.ext.supplemental-metadata.json"; older ones use "<name>.ext.json".
 * Duplicates relocate the counter: "foo(1).jpg" -> "foo.jpg(1).json".
 */
function sidecarCandidates(filename: string): string[] {
  const names = new Set<string>([
    `${filename}.json`,
    `${filename}.supplemental-metadata.json`,
  ]);
  const dup = filename.match(/^(.*)\((\d+)\)(\.[^.]+)$/);
  if (dup) {
    const [, base, n, ext] = dup;
    names.add(`${base}${ext}(${n}).json`);
    names.add(`${base}${ext}.supplemental-metadata(${n}).json`);
  }
  return [...names];
}

/** Strip the trailing ".json" and any "(truncated) supplemental-metadata" tail. */
function sidecarBase(jsonName: string): string {
  return jsonName
    .replace(/\.supplemental-met[a-z-]*(\(\d+\))?\.json$/i, "")
    .replace(/\.json$/i, "");
}

async function findSidecar(localPath: string): Promise<string | undefined> {
  const dir = path.dirname(localPath);
  const filename = path.basename(localPath);
  const jsons = await jsonFilesIn(dir);
  if (jsons.length === 0) return undefined;

  const present = new Set(jsons);
  for (const cand of sidecarCandidates(filename)) {
    if (present.has(cand)) return path.join(dir, cand);
  }

  // Truncation fallback: Google caps the sidecar filename length, so the stored
  // .json can be a prefix of "<filename>...". Pick the longest base that is a
  // prefix of our filename (longest = most specific match).
  let best: string | undefined;
  let bestLen = 0;
  for (const j of jsons) {
    const base = sidecarBase(j);
    if (base.length >= 8 && filename.startsWith(base) && base.length > bestLen) {
      best = j;
      bestLen = base.length;
    }
  }
  return best ? path.join(dir, best) : undefined;
}

function pickGeo(s: RawSidecar): GeoPoint | undefined {
  // geoData holds the (possibly user-edited) location; geoDataExif mirrors the
  // original EXIF. Both are 0/0 when Google has no location for the item.
  for (const g of [s.geoData, s.geoDataExif]) {
    const lat = g?.latitude;
    const lng = g?.longitude;
    if (Number.isFinite(lat) && Number.isFinite(lng) && !(lat === 0 && lng === 0)) {
      return { lat: lat as number, lng: lng as number };
    }
  }
  return undefined;
}

/**
 * Read GPS + capture time from a Google Takeout sidecar JSON sitting next to
 * `localPath`. Returns undefined when no sidecar is found or it carries neither.
 */
export async function readTakeoutSidecar(localPath: string): Promise<TakeoutMeta | undefined> {
  const sidecar = await findSidecar(localPath);
  if (!sidecar) return undefined;

  let raw: RawSidecar;
  try {
    raw = JSON.parse(await fs.readFile(sidecar, "utf8")) as RawSidecar;
  } catch {
    return undefined;
  }

  const meta: TakeoutMeta = {};
  const gps = pickGeo(raw);
  if (gps) meta.gps = gps;

  const ts = raw.photoTakenTime?.timestamp ?? raw.creationTime?.timestamp;
  if (ts) {
    const secs = Number(ts);
    if (Number.isFinite(secs)) meta.capturedAt = secs * 1000;
  }

  return meta.gps || meta.capturedAt !== undefined ? meta : undefined;
}
