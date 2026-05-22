import type { Asset } from "@gc-media/shared";

/** The thumbnail content rendered inside an AdvancedMarker. */
export function Pin({ asset }: { asset: Asset }) {
  return (
    <div className="pin-wrap">
      <div className={`pin${asset.type === "video" ? " video" : ""}`}>
        <img src={asset.thumbnailUrl} alt="" loading="lazy" />
      </div>
    </div>
  );
}
