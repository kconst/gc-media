import exifr from "exifr";
import type { GeoPoint } from "@gc-media/shared";

export interface ExifMeta {
  gps?: GeoPoint;
  /** Capture time as epoch ms (UTC), when present. */
  capturedAt?: number;
}

/** Read GPS + capture time from an image file's EXIF. Returns {} if absent. */
export async function readExif(localPath: string): Promise<ExifMeta> {
  const meta: ExifMeta = {};
  try {
    const gps = await exifr.gps(localPath);
    if (gps && Number.isFinite(gps.latitude) && Number.isFinite(gps.longitude)) {
      meta.gps = { lat: gps.latitude, lng: gps.longitude };
    }
  } catch {
    // Not an image / no GPS block.
  }
  try {
    const parsed = (await exifr.parse(localPath, ["DateTimeOriginal", "CreateDate"])) as
      | { DateTimeOriginal?: Date; CreateDate?: Date }
      | undefined;
    const when = parsed?.DateTimeOriginal ?? parsed?.CreateDate;
    if (when instanceof Date && !Number.isNaN(when.getTime())) {
      meta.capturedAt = when.getTime();
    }
  } catch {
    // ignore
  }
  return meta;
}
