import type { AssetType, GeoPoint, GeoSource } from "@gc-media/shared";

/** A media file discovered by a source adapter, sitting on local disk. */
export interface IngestItem {
  /** Stable content-hash id (sha1 of bytes), used as the asset id + S3 prefix. */
  id: string;
  /** Absolute path to the local file. */
  localPath: string;
  originalFilename: string;
  type: AssetType;
  /** Which source produced it, for credit/debugging. */
  source: string;
  credit?: string;
}

/** A continuous GPS sample from GoPro telemetry, used for time-matching. */
export interface GpsSample {
  /** Epoch milliseconds (UTC). */
  t: number;
  lat: number;
  lng: number;
}

export interface ResolvedGeo {
  point: GeoPoint;
  source: GeoSource;
}
