export type MediaType = "all" | "photo" | "video";

interface Props {
  value: MediaType;
  onChange: (t: MediaType) => void;
}

export function MediaTypeToggle({ value, onChange }: Props) {
  return (
    <div className="media-toggle">
      <div className="track-switch" role="group" aria-label="Media type">
        <button className={value === "all" ? "on" : ""} onClick={() => onChange("all")}>All</button>
        <button className={value === "photo" ? "on" : ""} onClick={() => onChange("photo")}>Photos</button>
        <button className={value === "video" ? "on" : ""} onClick={() => onChange("video")}>Videos</button>
      </div>
    </div>
  );
}
