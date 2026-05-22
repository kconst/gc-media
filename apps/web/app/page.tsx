"use client";

import { useMemo, useState } from "react";
import { APIProvider } from "@vis.gl/react-google-maps";
import { LABEL_CATEGORIES, type Asset } from "@gc-media/shared";
import { useManifest } from "@/hooks/useManifest";
import { MapView } from "@/components/MapView";
import { PinModal } from "@/components/PinModal";
import { LabelFilter, labelKey } from "@/components/LabelFilter";

export default function Home() {
  const { manifest, loading, error } = useManifest();
  const [active, setActive] = useState<Set<string>>(new Set());
  const [selected, setSelected] = useState<Asset | null>(null);

  const apiKey = process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY ?? "";
  const assets = manifest?.assets ?? [];

  // OR filter: with labels selected, show assets carrying at least one.
  const visible = useMemo(() => {
    if (active.size === 0) return assets;
    return assets.filter((a) =>
      LABEL_CATEGORIES.some((c) => a.labels[c].some((v) => active.has(labelKey(c, v)))),
    );
  }, [assets, active]);

  function toggle(key: string) {
    setActive((prev) => {
      const next = new Set(prev);
      next.has(key) ? next.delete(key) : next.add(key);
      return next;
    });
  }

  return (
    <div className="app">
      {!apiKey && <div className="status">Set NEXT_PUBLIC_GOOGLE_MAPS_API_KEY to load the map.</div>}
      {loading && <div className="status">Loading pins…</div>}
      {error && <div className="status">Error: {error}</div>}

      {apiKey && (
        <APIProvider apiKey={apiKey}>
          <LabelFilter assets={assets} active={active} onToggle={toggle} onClear={() => setActive(new Set())} />
          <MapView assets={visible} bounds={manifest?.bounds} onSelect={setSelected} />
        </APIProvider>
      )}

      {selected && <PinModal asset={selected} onClose={() => setSelected(null)} />}
    </div>
  );
}
