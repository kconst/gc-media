import { useMemo } from "react";
import type { Asset } from "@gc-media/shared";

function fmt(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = Math.round(sec % 60);
  return m ? `${m}m ${s}s` : `${s}s`;
}

interface Props {
  assets: Asset[];
  /** Inclusive [min, max] seconds; null means no filter (show all). */
  range: [number, number];
  onChange: (r: [number, number] | null) => void;
}

export function VideoDurationFilter({ assets, range, onChange }: Props) {
  const max = useMemo(() => {
    const m = Math.max(0, ...assets.filter((a) => a.type === "video").map((a) => a.durationSec ?? 0));
    return Math.ceil(m);
  }, [assets]);

  if (max <= 0) return null; // no durations known yet
  const [lo, hi] = range;

  // When the range covers the full extent, clear the filter so all videos show.
  function emit(newLo: number, newHi: number) {
    if (newLo <= 0 && newHi >= max) onChange(null);
    else onChange([newLo, newHi]);
  }

  const isAll = lo <= 0 && hi >= max;

  return (
    <div className="dur-filter">
      <div className="dur-head">
        Video length: {isAll ? "All" : `${fmt(lo)} – ${fmt(hi)}`}
      </div>
      <input
        type="range"
        min={0}
        max={max}
        value={Math.min(lo, hi)}
        onChange={(e) => emit(Math.min(Number(e.target.value), hi), hi)}
        aria-label="Minimum video length"
      />
      <input
        type="range"
        min={0}
        max={max}
        value={Math.max(hi, lo)}
        onChange={(e) => emit(lo, Math.max(Number(e.target.value), lo))}
        aria-label="Maximum video length"
      />
      <div className="dur-note">Photos always shown · {fmt(max)} max</div>
    </div>
  );
}
