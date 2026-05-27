import fs from "node:fs/promises";
import { createWriteStream } from "node:fs";
import { Readable } from "node:stream";
import { pipeline as streamPipeline } from "node:stream/promises";
import path from "node:path";
import type { AssetType } from "@gc-media/shared";
import type { IngestItem } from "../types.js";
import { hashFile } from "../util/hash.js";

const ACCEPT = "application/vnd.gopro.jk.media+json; version=2.0.0";

// Skip downloading clips whose original exceeds this (multi-hour "concat"
// recordings): they're 20-40GB, take ~hours to transcode, and their web video
// would blow past S3's 5GB single-upload limit. Override via env.
const MAX_DOWNLOAD_BYTES = (Number(process.env.GOPRO_MAX_DOWNLOAD_GB) || 12) * 1024 ** 3;

export interface GoproMedia {
  id: string;
  filename: string;
  capturedAt: string;
  type: string;
}

function authHeaders(token: string) {
  return { authorization: `Bearer ${token}`, accept: ACCEPT };
}

/** List the whole media library (filename + capture time), paginated. */
export async function listGoproMedia(token: string): Promise<GoproMedia[]> {
  const out: GoproMedia[] = [];
  for (let page = 1; page <= 500; page++) {
    const r = await fetch(
      `https://api.gopro.com/media/search?fields=filename,captured_at,type&per_page=100&page=${page}`,
      { headers: authHeaders(token) },
    );
    if (!r.ok) throw new Error(`media/search HTTP ${r.status}`);
    const j = (await r.json()) as {
      _embedded?: { media?: { id: string; filename?: string; captured_at?: string; type?: string }[] };
      _pages?: { current_page: number; total_pages: number };
    };
    for (const m of j._embedded?.media ?? []) {
      if (m.filename && m.captured_at) {
        out.push({ id: m.id, filename: m.filename, capturedAt: m.captured_at, type: m.type ?? "Video" });
      }
    }
    if (!j._pages || j._pages.current_page >= j._pages.total_pages) break;
  }
  return out;
}

/** Resolve a downloadable URL for a clip, preferring the joined original. */
async function sourceUrl(token: string, id: string): Promise<string | undefined> {
  const r = await fetch(`https://api.gopro.com/media/${id}/download`, { headers: authHeaders(token) });
  if (!r.ok) throw new Error(`download HTTP ${r.status}`);
  const j = (await r.json()) as { _embedded?: { variations?: { label?: string; url?: string }[] } };
  const vs = j._embedded?.variations ?? [];
  const pick =
    vs.find((v) => v.label === "concat" && v.url) ??
    vs.find((v) => v.label === "source" && v.url) ??
    vs.find((v) => v.url);
  return pick?.url;
}

/** Download one clip's original into `destDir`, returning an IngestItem. */
export async function downloadGoproMedia(
  token: string,
  m: GoproMedia,
  destDir: string,
  maxBytes: number = MAX_DOWNLOAD_BYTES,
): Promise<IngestItem> {
  const url = await sourceUrl(token, m.id);
  if (!url) throw new Error("no downloadable source");
  await fs.mkdir(destDir, { recursive: true });
  const dest = path.join(destDir, path.basename(m.filename));

  const r = await fetch(url);
  if (!r.ok || !r.body) throw new Error(`source HTTP ${r.status}`);
  const len = Number(r.headers.get("content-length") || 0);
  if (maxBytes > 0 && len > maxBytes) {
    await r.body.cancel().catch(() => {});
    throw new Error(`too large (${(len / 1024 ** 3).toFixed(1)}GB) — skipped`);
  }
  try {
    await streamPipeline(Readable.fromWeb(r.body as Parameters<typeof Readable.fromWeb>[0]), createWriteStream(dest));
  } catch (e) {
    // Don't leave a partial file hogging disk if the download is interrupted.
    await fs.rm(dest, { force: true }).catch(() => {});
    throw e;
  }

  const id = await hashFile(dest);
  const type: AssetType = m.type === "Photo" ? "photo" : "video";
  return {
    id,
    localPath: dest,
    originalFilename: path.basename(m.filename),
    type,
    source: "gopro",
    capturedAt: Number.isFinite(Date.parse(m.capturedAt)) ? Date.parse(m.capturedAt) : undefined,
  };
}
