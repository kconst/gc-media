import type { TrailDef } from "@gc-media/shared";

interface Props {
  trails: TrailDef[];
  active: Set<string>;
  onToggle: (id: string) => void;
}

export function TrailToggles({ trails, active, onToggle }: Props) {
  return (
    <div className="trail-toggles">
      <div className="trail-toggles-head">Trails</div>
      {trails.map((t) => (
        <button
          key={t.id}
          className={`trail-btn${active.has(t.id) ? " on" : ""}`}
          style={{ "--tc": t.color } as React.CSSProperties}
          onClick={() => onToggle(t.id)}
          title={active.has(t.id) ? `Hide ${t.name}` : `Highlight ${t.name}`}
        >
          <span className="trail-dot" />
          {t.name}
        </button>
      ))}
    </div>
  );
}
