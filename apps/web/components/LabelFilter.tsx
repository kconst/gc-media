import { useState } from "react";
import { LABEL_CATEGORIES, type Asset, type LabelCategory } from "@gc-media/shared";

const CATEGORY_TITLES: Record<LabelCategory, string> = {
  plants: "Plants",
  animals: "Animals",
  peopleMorale: "People / Morale",
  interesting: "Interesting",
};

/** Build the set of distinct labels present across all assets, per category. */
export function collectLabels(assets: Asset[]): Record<LabelCategory, string[]> {
  const out = {
    plants: new Set<string>(),
    animals: new Set<string>(),
    peopleMorale: new Set<string>(),
    interesting: new Set<string>(),
  };
  for (const a of assets) {
    for (const c of LABEL_CATEGORIES) for (const v of a.labels[c]) out[c].add(v);
  }
  return {
    plants: [...out.plants].sort(),
    animals: [...out.animals].sort(),
    peopleMorale: [...out.peopleMorale].sort(),
    interesting: [...out.interesting].sort(),
  };
}

export function labelKey(category: LabelCategory, value: string): string {
  return `${category}:${value}`;
}

interface Props {
  assets: Asset[];
  active: Set<string>;
  onToggle: (key: string) => void;
  onClear: () => void;
}

export function LabelFilter({ assets, active, onToggle, onClear }: Props) {
  const [open, setOpen] = useState(false);
  const labels = collectLabels(assets);
  if (!LABEL_CATEGORIES.some((c) => labels[c].length > 0)) return null;

  return (
    <div className={`filter${open ? " open" : ""}`}>
      <button className="filter-head" onClick={() => setOpen((o) => !o)}>
        <span>{open ? "▾" : "▸"} Labels</span>
        {active.size > 0 && <span className="badge">{active.size}</span>}
      </button>
      {open && (
        <div className="filter-body">
          {active.size > 0 && (
            <button className="clear" onClick={onClear}>clear all</button>
          )}
          {LABEL_CATEGORIES.map((c) =>
            labels[c].length === 0 ? null : (
              <div key={c}>
                <div className="cat">{CATEGORY_TITLES[c]}</div>
                {labels[c].map((v) => {
                  const key = labelKey(c, v);
                  return (
                    <span
                      key={key}
                      className={`chip${active.has(key) ? " active" : ""}`}
                      onClick={() => onToggle(key)}
                    >
                      {v}
                    </span>
                  );
                })}
              </div>
            ),
          )}
        </div>
      )}
    </div>
  );
}
