import fs from "node:fs/promises";
import path from "node:path";
import { emptyLabels, type Asset, type Labels, type TrackPoint } from "@gc-media/shared";
import { config } from "./config.js";
import { State } from "./state.js";
import { GeoResolver } from "./geo/resolver.js";
import { readExif } from "./meta/exif.js";
import { readTakeoutSidecar } from "./meta/takeout.js";
import { extractGoproTrack } from "./meta/gopro.js";
import { loadGpxTracks } from "./meta/gpx.js";
import { readVideoCapturedAt } from "./meta/videoTime.js";
import { makeDerivatives, sampleFrames } from "./media/derivatives.js";
import { uploadFile } from "./media/s3.js";
import { analyzeImages } from "./ai/claude.js";
import { loadManifest, saveAndPublish, saveAndPublishTrack, upsertAssets } from "./manifest.js";
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
  /** Minutes to add to each asset's capture time before GPX time-matching
   * (to align a camera clock that isn't UTC). */
  timeOffsetMinutes?: number;
  /** Sink for progress lines (defaults to console.log); used by the web UI. */
  log?: (msg: string) => void;
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
  const log = opts.log ?? ((m: string) => console.log(m));
  const state = await State.load();
  log("Scanning source for media…");
  const all = await gather(opts);
  const items = all.filter((it) => opts.force || !state.has(it.id));
  log(`Discovered ${all.length} assets, ${items.length} new to process.`);
  await runItems(items, opts, state, log);
}

/** Process an explicit set of already-gathered items (e.g. one GoPro batch). */
export async function runPipelineOnItems(items: IngestItem[], opts: RunOptions): Promise<void> {
  const log = opts.log ?? ((m: string) => console.log(m));
  const state = await State.load();
  const fresh = items.filter((it) => opts.force || !state.has(it.id));
  await runItems(fresh, opts, state, log);
}

async function runItems(
  items: IngestItem[],
  opts: RunOptions,
  state: State,
  log: (m: string) => void,
): Promise<void> {
  // Pass 1: build the GoPro GPS timeline + remember each clip's own position.
  const resolver = new GeoResolver();
  const ownGps = new Map<string, GpsSample[]>();
  const videos = items.filter((i) => i.type === "video");
  if (videos.length) log(`Scanning ${videos.length} video(s) for a GPS track…`);
  for (const it of videos) {
    log(`  reading GPS from ${it.originalFilename}…`);
    const track = await extractGoproTrack(it.localPath, log);
    if (track.length) {
      resolver.addTrack(track);
      ownGps.set(it.id, track);
    }
  }

  // Fold in any GPX tracks (e.g. Garmin) found alongside the media, so videos
  // whose own files carry no GPS can be placed by timestamp.
  const gpxDirs = [...new Set([opts.dir, config.incomingDir].filter(Boolean) as string[])];
  const gpxPoints: TrackPoint[] = [];
  for (const d of gpxDirs) {
    const gpx = await loadGpxTracks(d);
    if (gpx.length) {
      resolver.addTrack(gpx);
      gpxPoints.push(...gpx);
      log(`Loaded ${gpx.length} GPX track points from ${d}.`);
    }
  }
  log(`GPS timeline: ${resolver.trackSize} samples.`);

  // Publish the path so the map can overlay it (only when we actually found a
  // track, so a media-only run never wipes an existing overlay).
  if (gpxPoints.length) {
    gpxPoints.sort((a, b) => a.t - b.t);
    await saveAndPublishTrack(gpxPoints);
  }

  const newAssets: Asset[] = [];

  // Pass 2: process each asset.
  for (const it of items) {
    try {
      const exif = it.type === "photo" ? await readExif(it.localPath) : {};
      const sidecar = await readTakeoutSidecar(it.localPath);
      const ownTrack = ownGps.get(it.id);
      const videoTime =
        it.type === "video" && !ownTrack ? await readVideoCapturedAt(it.localPath) : undefined;

      const capturedAt = it.capturedAt ?? exif.capturedAt ?? sidecar?.capturedAt ?? ownTrack?.[0]?.t ?? videoTime;
      // Shift the capture time to align a non-UTC camera clock with the GPX track.
      const matchAt =
        capturedAt !== undefined && opts.timeOffsetMinutes
          ? capturedAt + opts.timeOffsetMinutes * 60_000
          : capturedAt;

      const geo = resolver.resolve({
        exifGps: exif.gps,
        ownTrackGps: ownTrack ? GeoResolver.centroid(ownTrack) : undefined,
        takeoutGps: sidecar?.gps,
        capturedAt: matchAt,
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
        try {
          const analysis = await analyzeImages(frames, it.type === "video");
          description = analysis.description;
          labels = analysis.labels;
        } catch (e) {
          // Best-effort: a failed description must not drop the clip.
          log(`  (AI skipped for ${it.originalFilename}: ${(e as Error).message})`);
        } finally {
          // Drop the sampled video frames (temp dir under cacheDir).
          if (it.type === "video" && frames[0]) {
            await fs.rm(path.dirname(frames[0]), { recursive: true, force: true }).catch(() => {});
          }
        }
      }

      const base: PendingAsset = {
        id: it.id,
        type: it.type,
        thumbnailUrl,
        fullUrl,
        posterUrl,
        capturedAt: capturedAt ? new Date(capturedAt).toISOString() : undefined,
        originalFilename: it.originalFilename,
        description,
        labels,
        credit: it.credit,
      };

      if (geo) {
        newAssets.push({ ...base, lat: geo.point.lat, lng: geo.point.lng, geoSource: geo.source });
      } else {
        await addPending(base);
        log(`  ${it.originalFilename}: needs manual placement.`);
      }

      state.set({ id: it.id, processedAt: new Date().toISOString(), geolocated: !!geo });
      await state.save();
      // Reclaim the uploaded derivatives so a large batch can't fill the disk.
      await fs.rm(path.join(config.derivativesDir, it.id), { recursive: true, force: true }).catch(() => {});
      log(`  processed ${it.originalFilename}${geo ? ` (${geo.source})` : ""}`);
    } catch (err) {
      log(`  FAILED ${it.originalFilename}: ${(err as Error).message}`);
    }
  }

  if (newAssets.length) {
    const manifest = upsertAssets(await loadManifest(), newAssets);
    await saveAndPublish(manifest);
  }
  log(`Done. ${newAssets.length} pins added; place any pending assets from the panel.`);
}
