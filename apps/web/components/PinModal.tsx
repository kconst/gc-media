import { useEffect, useRef } from "react";
import { LABEL_CATEGORIES, type Asset, type LabelCategory } from "@gc-media/shared";

const CATEGORY_TITLES: Record<LabelCategory, string> = {
  plants: "Plants",
  animals: "Animals",
  peopleMorale: "People / Morale",
  interesting: "Interesting",
};

interface Props {
  asset: Asset;
  /** Position within the track-ordered list (0-based) and the list size. */
  index: number;
  total: number;
  onPrev: () => void;
  onNext: () => void;
  onClose: () => void;
}

export function PinModal({ asset, index, total, onPrev, onNext, onClose }: Props) {
  const mediaRef = useRef<HTMLDivElement>(null);
  const hasPrev = index > 0;
  const hasNext = index >= 0 && index < total - 1;

  // Arrow keys step through the track in order; Escape closes.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
      else if (e.key === "ArrowLeft" && hasPrev) onPrev();
      else if (e.key === "ArrowRight" && hasNext) onNext();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [hasPrev, hasNext, onPrev, onNext, onClose]);

  function goFullscreen() {
    const el = mediaRef.current?.querySelector("video, img") as HTMLElement | null;
    el?.requestFullscreen?.();
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="media" ref={mediaRef}>
          {asset.type === "video" ? (
            <video
              src={asset.fullUrl}
              poster={asset.posterUrl}
              controls
              playsInline
              muted
              controlsList="nodownload"
              // Keep playback silent even if a viewer tries to unmute via the controls.
              onVolumeChange={(e) => {
                const v = e.currentTarget;
                if (!v.muted || v.volume > 0) {
                  v.muted = true;
                  v.volume = 0;
                }
              }}
            />
          ) : (
            <img src={asset.fullUrl} alt={asset.description.slice(0, 80)} />
          )}
        </div>
        <div className="toolbar">
          <button onClick={onPrev} disabled={!hasPrev}>‹ Prev</button>
          {total > 0 && <span className="counter">{index + 1} / {total}</span>}
          <button onClick={onNext} disabled={!hasNext}>Next ›</button>
          <span style={{ flex: 1 }} />
          <button onClick={goFullscreen}>Fullscreen</button>
          <button onClick={onClose}>Close</button>
        </div>
        <div className="body">
          <p className="desc">{asset.description}</p>
          {asset.credit && <p style={{ fontSize: 12, color: "#888" }}>Contributed by {asset.credit}</p>}
          {LABEL_CATEGORIES.map((c) =>
            asset.labels[c].length === 0 ? null : (
              <div className="cat-row" key={c}>
                <div className="cat">{CATEGORY_TITLES[c]}</div>
                {asset.labels[c].map((v) => (
                  <span className="chip" key={v}>{v}</span>
                ))}
              </div>
            ),
          )}
        </div>
      </div>
    </div>
  );
}
