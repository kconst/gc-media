import fs from "node:fs/promises";
import { createWriteStream } from "node:fs";
import { Readable } from "node:stream";
import { pipeline as streamPipeline } from "node:stream/promises";
import path from "node:path";
import type { AssetType } from "@gc-media/shared";
import type { IngestItem } from "../types.js";
import { hashFile } from "../util/hash.js";

const HEADERS = { "content-type": "application/json", origin: "https://www.icloud.com" };

/** Extract the album token from a full URL or accept a bare token. */
export function icloudToken(input: string): string {
  const m = input.match(/#([A-Za-z0-9]+)/);
  return (m?.[1] ?? input).trim();
}

interface Derivative {
  fileSize?: string;
  checksum?: string;
}
interface RawPhoto {
  photoGuid: string;
  dateCreated?: string;
  mediaAssetType?: string;
  derivatives?: Record<string, Derivative>;
}

async function webstream(host: string, token: string) {
  const r = await fetch(`https://${host}/${token}/sharedstreams/webstream`, {
    method: "POST",
    headers: HEADERS,
    body: JSON.stringify({ streamCtag: null }),
  });
  return JSON.parse(await r.text()) as { photos?: RawPhoto[]; "X-Apple-MMe-Host"?: string };
}

/** Resolve the album's partition host and list its photos/videos. */
export async function listIcloudAssets(token: string): Promise<{ host: string; photos: RawPhoto[] }> {
  let host = "p01-sharedstreams.icloud.com";
  let body = await webstream(host, token);
  if (body["X-Apple-MMe-Host"]) {
    host = body["X-Apple-MMe-Host"];
    body = await webstream(host, token);
  }
  return { host, photos: body.photos ?? [] };
}

/** Map each derivative checksum to a signed download URL. */
async function assetUrls(host: string, token: string, guids: string[]): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  for (let i = 0; i < guids.length; i += 90) {
    const batch = guids.slice(i, i + 90);
    const r = await fetch(`https://${host}/${token}/sharedstreams/webasseturls`, {
      method: "POST",
      headers: HEADERS,
      body: JSON.stringify({ photoGuids: batch }),
    });
    const j = (await r.json()) as { items?: Record<string, { url_location: string; url_path: string }> };
    for (const [checksum, loc] of Object.entries(j.items ?? {})) {
      map.set(checksum, `https://${loc.url_location}${loc.url_path}`);
    }
  }
  return map;
}

/** Largest-fileSize derivative (full-res photo or the video file). */
function bestDerivative(p: RawPhoto): Derivative | undefined {
  let best: Derivative | undefined;
  let bestSize = -1;
  for (const dv of Object.values(p.derivatives ?? {})) {
    const sz = Number(dv.fileSize ?? 0);
    if (sz > bestSize) {
      bestSize = sz;
      best = dv;
    }
  }
  return best;
}

export interface IcloudItem {
  guid: string;
  capturedAt: number;
  type: AssetType;
  checksum: string;
}

/** Photos/videos as ingest candidates, with capture time (epoch ms). */
export function icloudItems(photos: RawPhoto[]): IcloudItem[] {
  const out: IcloudItem[] = [];
  for (const p of photos) {
    const dv = bestDerivative(p);
    const t = p.dateCreated ? Date.parse(p.dateCreated) : NaN;
    if (!dv?.checksum || !Number.isFinite(t)) continue;
    out.push({
      guid: p.photoGuid,
      capturedAt: t,
      type: p.mediaAssetType === "video" ? "video" : "photo",
      checksum: dv.checksum,
    });
  }
  return out;
}

/** Resolve download URLs for the given items' chosen derivatives. */
export async function icloudUrls(host: string, token: string, items: IcloudItem[]): Promise<Map<string, string>> {
  return assetUrls(host, token, items.map((i) => i.guid));
}

/** Download one item into `destDir`, returning an IngestItem. */
export async function downloadIcloudItem(
  url: string,
  item: IcloudItem,
  destDir: string,
): Promise<IngestItem> {
  await fs.mkdir(destDir, { recursive: true });
  const ext = item.type === "video" ? ".mov" : ".jpg";
  const name = `icloud_${item.guid.slice(0, 8)}${ext}`;
  const dest = path.join(destDir, name);
  const r = await fetch(url);
  if (!r.ok || !r.body) throw new Error(`download HTTP ${r.status}`);
  try {
    await streamPipeline(Readable.fromWeb(r.body as Parameters<typeof Readable.fromWeb>[0]), createWriteStream(dest));
  } catch (e) {
    await fs.rm(dest, { force: true }).catch(() => {});
    throw e;
  }
  return {
    id: await hashFile(dest),
    localPath: dest,
    originalFilename: name,
    type: item.type,
    source: "icloud",
    capturedAt: item.capturedAt,
  };
}
