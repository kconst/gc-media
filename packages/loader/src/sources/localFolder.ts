import fs from "node:fs/promises";
import path from "node:path";
import type { AssetType } from "@gc-media/shared";
import type { IngestItem } from "../types.js";
import { hashFile } from "../util/hash.js";

const PHOTO_EXT = new Set([".jpg", ".jpeg", ".png", ".heic", ".heif", ".webp"]);
const VIDEO_EXT = new Set([".mp4", ".mov", ".m4v", ".avi"]);

function classify(file: string): AssetType | undefined {
  const ext = path.extname(file).toLowerCase();
  if (PHOTO_EXT.has(ext)) return "photo";
  if (VIDEO_EXT.has(ext)) return "video";
  return undefined;
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
    else if (entry.isFile()) yield full;
  }
}

/**
 * Discover media files under `dir` (recursively). Handles GoPro SD originals,
 * Quik exports, and unzipped Google Takeout folders alike.
 */
export async function ingestLocalFolder(
  dir: string,
  credit?: string,
): Promise<IngestItem[]> {
  const items: IngestItem[] = [];
  for await (const file of walk(dir)) {
    const type = classify(file);
    if (!type) continue;
    const id = await hashFile(file);
    items.push({
      id,
      localPath: file,
      originalFilename: path.basename(file),
      type,
      source: `local:${path.basename(dir)}`,
      credit,
    });
  }
  return items;
}
