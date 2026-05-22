import fs from "node:fs/promises";
import path from "node:path";
import type { Asset } from "@gc-media/shared";
import { config } from "./config.js";

/** An analyzed, uploaded asset that still needs coordinates assigned by hand. */
export type PendingAsset = Omit<Asset, "lat" | "lng" | "geoSource">;

const PENDING_PATH = path.join(config.dataDir, "pending.json");

export async function loadPending(): Promise<PendingAsset[]> {
  try {
    return JSON.parse(await fs.readFile(PENDING_PATH, "utf8")) as PendingAsset[];
  } catch {
    return [];
  }
}

export async function savePending(items: PendingAsset[]): Promise<void> {
  await fs.mkdir(config.dataDir, { recursive: true });
  await fs.writeFile(PENDING_PATH, JSON.stringify(items, null, 2));
}

export async function addPending(item: PendingAsset): Promise<void> {
  const all = await loadPending();
  if (!all.some((p) => p.id === item.id)) {
    all.push(item);
    await savePending(all);
  }
}
