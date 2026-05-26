import fs from "node:fs/promises";
import path from "node:path";
import {
  computeBounds,
  emptyManifest,
  type Asset,
  type Manifest,
  type Track,
  type TrackPoint,
} from "@gc-media/shared";
import { config } from "./config.js";
import { uploadBuffer } from "./media/s3.js";

export async function loadManifest(): Promise<Manifest> {
  try {
    const raw = await fs.readFile(config.manifestPath, "utf8");
    return JSON.parse(raw) as Manifest;
  } catch {
    return emptyManifest();
  }
}

/** Insert or replace assets by id, then recompute bounds + timestamp. */
export function upsertAssets(manifest: Manifest, assets: Asset[]): Manifest {
  const byId = new Map(manifest.assets.map((a) => [a.id, a]));
  for (const a of assets) byId.set(a.id, a);
  const merged = [...byId.values()];
  return {
    version: 1,
    generatedAt: new Date().toISOString(),
    bounds: computeBounds(merged),
    assets: merged,
  };
}

/** Drop an asset by id, then recompute bounds + timestamp. */
export function removeAsset(manifest: Manifest, id: string): Manifest {
  const assets = manifest.assets.filter((a) => a.id !== id);
  return {
    version: 1,
    generatedAt: new Date().toISOString(),
    bounds: computeBounds(assets),
    assets,
  };
}

/** Write the manifest locally and publish it where the web app reads it. */
export async function saveAndPublish(manifest: Manifest): Promise<void> {
  await fs.mkdir(config.dataDir, { recursive: true });
  const json = JSON.stringify(manifest, null, 2);
  await fs.writeFile(config.manifestPath, json);

  if (config.manifest.store === "s3") {
    // no-cache so the map always revalidates and picks up new pins promptly,
    // rather than serving a CloudFront-cached copy for the default TTL.
    const url = await uploadBuffer(
      config.manifest.key,
      json,
      "application/json",
      "no-cache",
    );
    console.log(`Published manifest → ${url}`);
  }
}

/** Evenly thin a track to at most `max` points, keeping the first and last. */
function downsample(points: TrackPoint[], max: number): TrackPoint[] {
  if (points.length <= max) return points;
  const step = (points.length - 1) / (max - 1);
  const out: TrackPoint[] = [];
  for (let i = 0; i < max; i++) out.push(points[Math.round(i * step)]!);
  return out;
}

/** Write the GPS track locally and publish it where the map reads it. */
export async function saveAndPublishTrack(points: TrackPoint[]): Promise<void> {
  const track: Track = {
    version: 1,
    generatedAt: new Date().toISOString(),
    points: downsample(points, 2000),
  };
  await fs.mkdir(config.dataDir, { recursive: true });
  const json = JSON.stringify(track);
  await fs.writeFile(path.join(config.dataDir, "track.json"), json);

  if (config.manifest.store === "s3") {
    const url = await uploadBuffer(
      config.manifest.trackKey,
      json,
      "application/json",
      "no-cache",
    );
    console.log(`Published track (${track.points.length} pts) → ${url}`);
  }
}
