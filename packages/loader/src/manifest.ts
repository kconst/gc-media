import fs from "node:fs/promises";
import {
  computeBounds,
  emptyManifest,
  type Asset,
  type Manifest,
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

/** Write the manifest locally and publish it where the web app reads it. */
export async function saveAndPublish(manifest: Manifest): Promise<void> {
  await fs.mkdir(config.dataDir, { recursive: true });
  const json = JSON.stringify(manifest, null, 2);
  await fs.writeFile(config.manifestPath, json);

  if (config.manifest.store === "s3") {
    const url = await uploadBuffer(
      config.manifest.key,
      json,
      "application/json",
    );
    console.log(`Published manifest → ${url}`);
  }
}
