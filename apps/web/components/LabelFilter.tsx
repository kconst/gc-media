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
  const labels = collectLabels(assets);
  return (
    <div className="filter">
      <h2>Filter by label{active.size > 0 && <button onClick={onClear} style={{ float: "right" }}>clear</button>}</h2>
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
  );
}
