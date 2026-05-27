"use client";

import { useMemo, useState } from "react";
import { APIProvider } from "@vis.gl/react-google-maps";
import { LABEL_CATEGORIES, type Asset } from "@gc-media/shared";
import { useManifest } from "@/hooks/useManifest";
import { useTrack } from "@/hooks/useTrack";
import { MapView } from "@/components/MapView";
import { PinModal } from "@/components/PinModal";
import { LabelFilter, labelKey } from "@/components/LabelFilter";
import { TrackControls } from "@/components/TrackControls";
import { metricDomain, type TrackMetric } from "@/components/TrackOverlay";

export default function Home() {
  const { manifest, loading, error } = useManifest();
  const { track } = useTrack();
  const [active, setActive] = useState<Set<string>>(new Set());
  const [selected, setSelected] = useState<Asset | null>(null);
  const [metric, setMetric] = useState<TrackMetric>("speed");

  const hasHr = useMemo(() => !!track?.points.some((p) => p.hr !== undefined), [track]);
  const legendDomain = useMemo(
    () => (track ? metricDomain(track.points, metric) : null),
    [track, metric],
  );

  const apiKey = process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY ?? "";
  const assets = manifest?.assets ?? [];

  // OR filter: with labels selected, show assets carrying at least one.
  const visible = useMemo(() => {
    if (active.size === 0) return assets;
    return assets.filter((a) =>
      LABEL_CATEGORIES.some((c) => a.labels[c].some((v) => active.has(labelKey(c, v)))),
    );
  }, [assets, active]);

  // Track order = capture-time order; undated pins sort to the end.
  const ordered = useMemo(() => {
    const t = (a: Asset) => (a.capturedAt ? Date.parse(a.capturedAt) : Number.POSITIVE_INFINITY);
    return [...visible].sort((a, b) => t(a) - t(b));
  }, [visible]);

  const selectedIndex = selected ? ordered.findIndex((a) => a.id === selected.id) : -1;
  function step(delta: number) {
    if (selectedIndex < 0) return;
    const next = ordered[selectedIndex + delta];
    if (next) setSelected(next);
  }

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
          {track && track.points.length > 1 && (
            <TrackControls metric={metric} onChange={setMetric} hasHr={hasHr} domain={legendDomain} />
          )}
          <MapView
            assets={visible}
            bounds={manifest?.bounds}
            track={track}
            trackMetric={metric}
            onSelect={setSelected}
          />
        </APIProvider>
      )}

      {selected && (
        <PinModal
          asset={selected}
          index={selectedIndex}
          total={ordered.length}
          onPrev={() => step(-1)}
          onNext={() => step(1)}
          onClose={() => setSelected(null)}
        />
      )}
    </div>
  );
}
