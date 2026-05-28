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

/** A named Grand Canyon trail corridor, defined by approximate waypoints. */
export interface TrailDef {
  id: string;
  name: string;
  /** CSS color for the highlight overlay. */
  color: string;
  waypoints: Array<{ lat: number; lng: number }>;
}

/**
 * Named trail corridors present on this trip (South Rim → Phantom Ranch).
 * Waypoints are approximate; matching is done by proximity at runtime.
 */
export const TRAIL_DEFS: TrailDef[] = [
  {
    id: "bright-angel",
    name: "Bright Angel Trail",
    color: "#1a73e8",
    waypoints: [
      { lat: 36.0573, lng: -112.1440 }, // South Rim Trailhead
      { lat: 36.0640, lng: -112.1412 }, // Upper switchbacks
      { lat: 36.0720, lng: -112.1365 }, // 3-Mile area
      { lat: 36.0870, lng: -112.1250 }, // Havasupai Gardens approach
      { lat: 36.0960, lng: -112.1145 }, // Lower canyon
      { lat: 36.1044, lng: -112.1012 }, // Silver Bridge / river
      { lat: 36.1058, lng: -112.0975 }, // Bright Angel Campground
    ],
  },
  {
    id: "south-kaibab",
    name: "South Kaibab Trail",
    color: "#e8711a",
    waypoints: [
      { lat: 36.0554, lng: -112.0862 }, // South Rim Trailhead
      { lat: 36.0595, lng: -112.0882 }, // Ooh Aah Point
      { lat: 36.0645, lng: -112.0905 }, // Cedar Ridge
      { lat: 36.0820, lng: -112.0966 }, // Skeleton Point
      { lat: 36.0985, lng: -112.0990 }, // Tonto Intersection / Tipoff
      { lat: 36.1048, lng: -112.0978 }, // Black Bridge / river
      { lat: 36.1058, lng: -112.0975 }, // Phantom Ranch
    ],
  },
  {
    id: "tonto",
    name: "Tonto Trail",
    color: "#16a34a",
    waypoints: [
      { lat: 36.0873, lng: -112.1230 }, // Havasupai Gardens (BA junction)
      { lat: 36.0900, lng: -112.1140 }, // Tonto Platform — west
      { lat: 36.0930, lng: -112.1050 }, // Tonto Platform — mid
      { lat: 36.0960, lng: -112.1010 }, // Tonto Platform — east approach
      { lat: 36.0985, lng: -112.0990 }, // Tipoff (SK junction)
    ],
  },
];

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
