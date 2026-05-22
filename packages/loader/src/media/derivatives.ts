import fs from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { execa } from "execa";
import { config } from "../config.js";
import type { IngestItem } from "../types.js";

export interface Derivatives {
  /** Small square-ish image used as the map pin + grid thumbnail. */
  thumbnail: { path: string; contentType: string };
  /** Web-friendly full asset (resized image, or transcoded mp4). */
  full: { path: string; contentType: string };
  /** Poster frame (videos only). */
  poster?: { path: string; contentType: string };
}

const THUMB_SIZE = 320;
const FULL_MAX = 1920;

/** Produce all renditions for an item under data/derivatives/<id>/. */
export async function makeDerivatives(item: IngestItem): Promise<Derivatives> {
  const outDir = path.join(config.derivativesDir, item.id);
  await fs.mkdir(outDir, { recursive: true });

  if (item.type === "photo") {
    const thumbPath = path.join(outDir, "thumb.jpg");
    const fullPath = path.join(outDir, "full.jpg");
    await sharp(item.localPath)
      .rotate()
      .resize(THUMB_SIZE, THUMB_SIZE, { fit: "cover" })
      .jpeg({ quality: 72 })
      .toFile(thumbPath);
    await sharp(item.localPath)
      .rotate()
      .resize(FULL_MAX, FULL_MAX, { fit: "inside", withoutEnlargement: true })
      .jpeg({ quality: 82 })
      .toFile(fullPath);
    return {
      thumbnail: { path: thumbPath, contentType: "image/jpeg" },
      full: { path: fullPath, contentType: "image/jpeg" },
    };
  }

  // Video: extract a poster frame, derive the thumbnail from it, and transcode
  // a web-friendly H.264 mp4. Requires ffmpeg on PATH.
  const posterPath = path.join(outDir, "poster.jpg");
  const thumbPath = path.join(outDir, "thumb.jpg");
  const fullPath = path.join(outDir, "web.mp4");

  await execa("ffmpeg", [
    "-y", "-ss", "0.5", "-i", item.localPath,
    "-frames:v", "1", "-q:v", "3", posterPath,
  ]);
  await sharp(posterPath)
    .resize(THUMB_SIZE, THUMB_SIZE, { fit: "cover" })
    .jpeg({ quality: 72 })
    .toFile(thumbPath);
  await execa("ffmpeg", [
    "-y", "-i", item.localPath,
    "-vf", `scale='min(${FULL_MAX},iw)':-2`,
    "-c:v", "libx264", "-preset", "veryfast", "-crf", "23",
    "-c:a", "aac", "-b:a", "128k", "-movflags", "+faststart",
    fullPath,
  ]);

  return {
    thumbnail: { path: thumbPath, contentType: "image/jpeg" },
    full: { path: fullPath, contentType: "video/mp4" },
    poster: { path: posterPath, contentType: "image/jpeg" },
  };
}

/** Sample up to `count` evenly-spaced JPEG frames for AI analysis of a video. */
export async function sampleFrames(localPath: string, count = 4): Promise<string[]> {
  await fs.mkdir(config.cacheDir, { recursive: true });
  const dir = await fs.mkdtemp(path.join(config.cacheDir, "frames-"));
  // fps filter picking `count` frames spread across the clip is awkward without
  // duration; sample 1 frame/2s and cap at `count`.
  await execa("ffmpeg", [
    "-y", "-i", localPath,
    "-vf", "fps=1/2", "-frames:v", String(count), "-q:v", "4",
    path.join(dir, "frame-%02d.jpg"),
  ]);
  const files = (await fs.readdir(dir))
    .filter((f) => f.endsWith(".jpg"))
    .sort()
    .map((f) => path.join(dir, f));
  return files;
}
