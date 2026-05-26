import type { GeoPoint } from "@gc-media/shared";
import type { GpsSample, ResolvedGeo } from "../types.js";

/** Max gap (ms) between a photo's capture time and a GPS sample to time-match. */
const MATCH_WINDOW_MS = 5 * 60 * 1000;

/**
 * Aggregates GPS samples from every GoPro video into one timeline, then
 * geolocates assets by timestamp. This is the "combine all three" strategy:
 * callers pass EXIF GPS first; whatever is left falls through to time-matching;
 * the remainder is flagged for the manual placement UI.
 */
export class GeoResolver {
  private track: GpsSample[] = [];

  addTrack(samples: GpsSample[]): void {
    if (samples.length === 0) return;
    this.track.push(...samples);
    this.track.sort((a, b) => a.t - b.t);
  }

  get trackSize(): number {
    return this.track.length;
  }

  /** Earliest and latest sample times (epoch ms), or undefined if no track. */
  range(): { start: number; end: number } | undefined {
    if (this.track.length === 0) return undefined;
    return { start: this.track[0]!.t, end: this.track[this.track.length - 1]!.t };
  }

  /** Nearest sample to time `t`, with the gap in ms. Undefined if no track. */
  nearest(t: number): { point: GeoPoint; gapMs: number } | undefined {
    if (this.track.length === 0) return undefined;
    let lo = 0;
    let hi = this.track.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (this.track[mid]!.t < t) lo = mid + 1;
      else hi = mid;
    }
    const candidates = [this.track[lo - 1], this.track[lo]].filter(Boolean) as GpsSample[];
    let best: GpsSample | undefined;
    let bestGap = Infinity;
    for (const c of candidates) {
      const gap = Math.abs(c.t - t);
      if (gap < bestGap) {
        bestGap = gap;
        best = c;
      }
    }
    if (!best) return undefined;
    return { point: { lat: best.lat, lng: best.lng }, gapMs: bestGap };
  }

  /** Median position of a clip's own samples — used to place the video pin. */
  static centroid(samples: GpsSample[]): GeoPoint | undefined {
    if (samples.length === 0) return undefined;
    const mid = samples[Math.floor(samples.length / 2)]!;
    return { lat: mid.lat, lng: mid.lng };
  }

  /**
   * Resolve coordinates for an asset.
   * Priority: own-track GPS → file EXIF → Takeout sidecar → time-match against
   * the track. Returns undefined when nothing matches (→ manual placement).
   */
  resolve(opts: {
    exifGps?: GeoPoint;
    ownTrackGps?: GeoPoint;
    takeoutGps?: GeoPoint;
    capturedAt?: number;
  }): ResolvedGeo | undefined {
    if (opts.ownTrackGps) return { point: opts.ownTrackGps, source: "gopro" };
    if (opts.exifGps) return { point: opts.exifGps, source: "exif" };
    if (opts.takeoutGps) return { point: opts.takeoutGps, source: "takeout" };
    if (opts.capturedAt !== undefined) {
      const matched = this.matchByTime(opts.capturedAt);
      // The aggregated track is fed by GPX tracks and/or GoPro telemetry; label
      // time-matched pins "gpx" since that's the primary external track source.
      if (matched) return { point: matched, source: "gpx" };
    }
    return undefined;
  }

  private matchByTime(t: number): GeoPoint | undefined {
    const near = this.nearest(t);
    return near && near.gapMs <= MATCH_WINDOW_MS ? near.point : undefined;
  }
}
