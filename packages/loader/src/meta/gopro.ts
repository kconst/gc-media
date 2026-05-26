import fs from "node:fs/promises";
import { createRequire } from "node:module";
import type { GpsSample } from "../types.js";

// Pure-JS CommonJS GPMF parsers without usable type declarations.
const require = createRequire(import.meta.url);
const gpmfExtract = require("gpmf-extract") as (
  buf: Buffer,
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

export async function extractGoproTrack(localPath: string): Promise<GpsSample[]> {
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
