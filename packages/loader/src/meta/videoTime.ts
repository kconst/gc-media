import { execa } from "execa";

/**
 * Read a video's capture time (epoch ms) from its container metadata via
 * ffprobe. GoPro Hero clips carry no GPS, but they do record a
 * `creation_time` (recording start) we can time-match against a GPX track.
 */
export async function readVideoCapturedAt(localPath: string): Promise<number | undefined> {
  try {
    const { stdout } = await execa("ffprobe", [
      "-v", "quiet",
      "-print_format", "json",
      "-show_entries", "format_tags=creation_time",
      localPath,
    ]);
    const parsed = JSON.parse(stdout) as { format?: { tags?: { creation_time?: string } } };
    const ct = parsed.format?.tags?.creation_time;
    if (ct) {
      const t = Date.parse(ct);
      if (Number.isFinite(t)) return t;
    }
  } catch {
    // ffprobe missing or tag absent.
  }
  return undefined;
}
