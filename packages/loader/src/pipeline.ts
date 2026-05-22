import path from "node:path";
import { emptyLabels, type Asset, type Labels } from "@gc-media/shared";
import { config } from "./config.js";
import { State } from "./state.js";
import { GeoResolver } from "./geo/resolver.js";
import { readExif } from "./meta/exif.js";
import { readTakeoutSidecar } from "./meta/takeout.js";
import { extractGoproTrack } from "./meta/gopro.js";
import { makeDerivatives, sampleFrames } from "./media/derivatives.js";
import { uploadFile } from "./media/s3.js";
import { analyzeImages } from "./ai/claude.js";
import { loadManifest, saveAndPublish, upsertAssets } from "./manifest.js";
import { addPending, type PendingAsset } from "./pending.js";
import { ingestLocalFolder } from "./sources/localFolder.js";
import { ingestGooglePhotos } from "./sources/googlePhotos.js";
import type { GpsSample, IngestItem } from "./types.js";

export interface RunOptions {
  source: "local" | "google" | "all";
  dir?: string;
  credit?: string;
  force?: boolean;
  /** Skip the Claude calls (faster dry runs). */
  noAi?: boolean;
}

async function gather(opts: RunOptions): Promise<IngestItem[]> {
  const items: IngestItem[] = [];
  if (opts.source === "local" || opts.source === "all") {
    const dir = opts.dir ?? config.incomingDir;
    items.push(...(await ingestLocalFolder(dir, opts.credit)));
  }
  if (opts.source === "google" || opts.source === "all") {
    items.push(...(await ingestGooglePhotos()));
  }
  // De-dupe by content id across sources.
  const seen = new Map<string, IngestItem>();
  for (const it of items) if (!seen.has(it.id)) seen.set(it.id, it);
  return [...seen.values()];
}

export async function runPipeline(opts: RunOptions): Promise<void> {
  const state = await State.load();
  const all = await gather(opts);
  const items = all.filter((it) => opts.force || !state.has(it.id));
  console.log(`Discovered ${all.length} assets, ${items.length} new to process.`);

  // Pass 1: build the GoPro GPS timeline + remember each clip's own position.
  const resolver = new GeoResolver();
  const ownGps = new Map<string, GpsSample[]>();
  for (const it of items.filter((i) => i.type === "video")) {
    const track = await extractGoproTrack(it.localPath);
    if (track.length) {
      resolver.addTrack(track);
      ownGps.set(it.id, track);
    }
  }
  console.log(`GoPro GPS timeline: ${resolver.trackSize} samples.`);

  const newAssets: Asset[] = [];

  // Pass 2: process each asset.
  for (const it of items) {
    try {
      const exif = it.type === "photo" ? await readExif(it.localPath) : {};
      const sidecar = await readTakeoutSidecar(it.localPath);
      const ownTrack = ownGps.get(it.id);
      const capturedAt = exif.capturedAt ?? sidecar?.capturedAt ?? ownTrack?.[0]?.t;

      const geo = resolver.resolve({
        exifGps: exif.gps,
        ownTrackGps: ownTrack ? GeoResolver.centroid(ownTrack) : undefined,
        takeoutGps: sidecar?.gps,
        capturedAt,
      });

      const der = await makeDerivatives(it);
      const thumbnailUrl = await uploadFile(`${it.id}/${path.basename(der.thumbnail.path)}`, der.thumbnail.path, der.thumbnail.contentType);
      const fullUrl = await uploadFile(`${it.id}/${path.basename(der.full.path)}`, der.full.path, der.full.contentType);
      const posterUrl = der.poster
        ? await uploadFile(`${it.id}/${path.basename(der.poster.path)}`, der.poster.path, der.poster.contentType)
        : undefined;

      let description = "";
      let labels: Labels = emptyLabels();
      if (!opts.noAi) {
        const frames = it.type === "video" ? await sampleFrames(it.localPath) : [der.full.path];
        const analysis = await analyzeImages(frames, it.type === "video");
        description = analysis.description;
        labels = analysis.labels;
      }

      const base: PendingAsset = {
        id: it.id,
        type: it.type,
        thumbnailUrl,
        fullUrl,
        posterUrl,
        capturedAt: capturedAt ? new Date(capturedAt).toISOString() : undefined,
        description,
        labels,
        credit: it.credit,
      };

      if (geo) {
        newAssets.push({ ...base, lat: geo.point.lat, lng: geo.point.lng, geoSource: geo.source });
      } else {
        await addPending(base);
        console.log(`  ${it.originalFilename}: needs manual placement.`);
      }

      state.set({ id: it.id, processedAt: new Date().toISOString(), geolocated: !!geo });
      await state.save();
      console.log(`  processed ${it.originalFilename}${geo ? ` (${geo.source})` : ""}`);
    } catch (err) {
      console.error(`  FAILED ${it.originalFilename}:`, (err as Error).message);
    }
  }

  if (newAssets.length) {
    const manifest = upsertAssets(await loadManifest(), newAssets);
    await saveAndPublish(manifest);
  }
  console.log(`Done. ${newAssets.length} pins added; run \`gc-loader place\` for any pending assets.`);
}
