import fs from "node:fs/promises";
import { createRequire } from "node:module";
import type { GpsSample } from "../types.js";

// Parsing GPMF telemetry loads the whole clip into memory, so a multi-GB 4K
// file can OOM a small instance. Skip the scan above this size — such clips
// can still be placed from a GPX track by timestamp. Override with
// GOPRO_MAX_SCAN_MB (0 disables the limit).
const MAX_SCAN_BYTES = (() => {
  const mb = Number(process.env.GOPRO_MAX_SCAN_MB);
  return Number.isFinite(mb) ? mb * 1024 * 1024 : 600 * 1024 * 1024;
})();

// Pure-JS CommonJS GPMF parsers without usable type declarations.
const require = createRequire(import.meta.url);
const gpmfExtract = require("gpmf-extract") as (
  input: unknown,
  opts?: unknown,
) => Promise<{ rawData: Buffer; timing: unknown }>;
const goproTelemetry = require("gopro-telemetry") as (
  input: unknown,
  opts: unknown,
  cb: (data: Record<string, unknown>) => void,
) => void;

/**
 * Extract the continuous GPS track (GPS5 stream) from a GoPro mp4's GPMF
 * telemetry. Returns samples sorted by time, or [] if no telemetry present
 * (e.g. a Quik cloud export that stripped it).
 */
/** Reject if `p` doesn't settle within `ms` (caps pathological mp4 parses). */
function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("gpmf timeout")), ms);
    p.then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
  });
}

/** mp4box.js floods the console with [BoxParser] warnings on non-GoPro files. */
function silenceConsole(): () => void {
  const saved = { log: console.log, warn: console.warn, error: console.error, info: console.info, debug: console.debug };
  const noop = () => {};
  console.log = console.warn = console.error = console.info = console.debug = noop;
  return () => Object.assign(console, saved);
}

export async function extractGoproTrack(
  localPath: string,
  log?: (msg: string) => void,
): Promise<GpsSample[]> {
  if (MAX_SCAN_BYTES > 0) {
    const size = await fs.stat(localPath).then((s) => s.size, () => 0);
    if (size > MAX_SCAN_BYTES) {
      log?.(`    skipping GPS scan (${Math.round(size / 1048576)} MB); will place by GPX/timestamp`);
      return [];
    }
  }

  const buffer = await fs.readFile(localPath);
  const restore = silenceConsole();
  let extracted: { rawData: Buffer; timing: unknown };
  try {
    extracted = await withTimeout(gpmfExtract(buffer), 60_000);
  } catch {
    restore();
    return [];
  }

  const telemetry = await new Promise<Record<string, unknown>>((resolve) => {
    goproTelemetry(extracted, { stream: ["GPS5"], GPS5Precision: 500 }, (data) =>
      resolve(data),
    );
  })
    .catch(() => ({}) as Record<string, unknown>)
    .finally(() => restore());

  const samples: GpsSample[] = [];
  for (const streamId of Object.keys(telemetry)) {
    const stream = (telemetry[streamId] as { streams?: { GPS5?: { samples?: GpsRaw[] } } })
      ?.streams?.GPS5;
    if (!stream?.samples) continue;
    for (const s of stream.samples) {
      const lat = s.value?.[0];
      const lng = s.value?.[1];
      if (typeof lat === "number" && typeof lng === "number" && s.date) {
        samples.push({ t: new Date(s.date).getTime(), lat, lng });
      }
    }
  }
  samples.sort((a, b) => a.t - b.t);
  return samples;
}

interface GpsRaw {
  date?: string;
  value?: number[];
}
