import { useRef } from "react";
import { LABEL_CATEGORIES, type Asset, type LabelCategory } from "@gc-media/shared";

const CATEGORY_TITLES: Record<LabelCategory, string> = {
  plants: "Plants",
  animals: "Animals",
  peopleMorale: "People / Morale",
  interesting: "Interesting",
};

interface Props {
  asset: Asset;
  onClose: () => void;
}

export function PinModal({ asset, onClose }: Props) {
  const mediaRef = useRef<HTMLDivElement>(null);

  function goFullscreen() {
    const el = mediaRef.current?.querySelector("video, img") as HTMLElement | null;
    el?.requestFullscreen?.();
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="media" ref={mediaRef}>
          {asset.type === "video" ? (
            <video src={asset.fullUrl} poster={asset.posterUrl} controls playsInline />
          ) : (
            <img src={asset.fullUrl} alt={asset.description.slice(0, 80)} />
          )}
        </div>
        <div className="toolbar">
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
