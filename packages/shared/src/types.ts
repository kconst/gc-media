/**
 * Canonical data model shared by the loader (writer) and the web app (reader).
 * The manifest is the single source of truth for what pins appear on the map.
 */

export type AssetType = "photo" | "video";

/** How a pin's coordinates were determined. */
export type GeoSource = "exif" | "takeout" | "gpx" | "gopro" | "manual";

/** The four label categories shown as filterable chips on the map and modal. */
export const LABEL_CATEGORIES = [
  "plants",
  "animals",
  "peopleMorale",
  "interesting",
] as const;

export type LabelCategory = (typeof LABEL_CATEGORIES)[number];

export type Labels = Record<LabelCategory, string[]>;

/** AI-produced analysis of a single asset. */
export interface Analysis {
  /** In-depth description of what the photo/clip shows. */
  description: string;
  labels: Labels;
}

export interface GeoPoint {
  lat: number;
  lng: number;
}

export interface Asset {
  /** Stable content-hash id; also the S3 key prefix. */
  id: string;
  type: AssetType;

  /** CloudFront URLs to the derivatives uploaded by the loader. */
  thumbnailUrl: string;
  fullUrl: string;
  /** Poster frame for videos. */
  posterUrl?: string;

  lat: number;
  lng: number;
  geoSource: GeoSource;

  /** ISO-8601 capture time, when known. */
  capturedAt?: string;

  /** Original filename at ingest (e.g. GX010055.MP4); used to match by name. */
  originalFilename?: string;

  /** Video duration in seconds (videos only). */
  durationSec?: number;

  description: string;
  labels: Labels;

  /** Display credit (e.g. which friend contributed it). */
  credit?: string;
}

export interface MapBounds {
  north: number;
  south: number;
  east: number;
  west: number;
}

export interface Manifest {
  version: 1;
  generatedAt: string;
  bounds?: MapBounds;
  assets: Asset[];
}

/** One sample of a GPS track published for the map's path overlay. */
export interface TrackPoint {
  lat: number;
  lng: number;
  /** Epoch milliseconds (UTC). */
  t: number;
  /** Heart rate in bpm, if the source carried it. */
  hr?: number;
  /** Ground speed in metres per second, derived from consecutive fixes. */
  speed?: number;
  /** Elevation in metres, if the source carried it. */
  ele?: number;
}

export interface Track {
  version: 1;
  generatedAt: string;
  points: TrackPoint[];
}

export function emptyLabels(): Labels {
  return { plants: [], animals: [], peopleMorale: [], interesting: [] };
}

export function emptyManifest(): Manifest {
  return { version: 1, generatedAt: new Date().toISOString(), assets: [] };
}

/** Compute a bounding box that fits every geolocated asset. */
export function computeBounds(assets: Asset[]): MapBounds | undefined {
  if (assets.length === 0) return undefined;
  let north = -90;
  let south = 90;
  let east = -180;
  let west = 180;
  for (const a of assets) {
    north = Math.max(north, a.lat);
    south = Math.min(south, a.lat);
    east = Math.max(east, a.lng);
    west = Math.min(west, a.lng);
  }
  return { north, south, east, west };
}
