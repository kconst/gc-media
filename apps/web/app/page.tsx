"use client";

import { useMemo, useState } from "react";
import { APIProvider } from "@vis.gl/react-google-maps";
import { LABEL_CATEGORIES, TRAIL_DEFS, type Asset } from "@gc-media/shared";
import { useManifest } from "@/hooks/useManifest";
import { useTrack } from "@/hooks/useTrack";
import { MapView } from "@/components/MapView";
import { PinModal } from "@/components/PinModal";
import { LabelFilter, labelKey } from "@/components/LabelFilter";
import { VideoDurationFilter } from "@/components/VideoDurationFilter";
import { MediaTypeToggle, type MediaType } from "@/components/MediaTypeToggle";
import { TrackControls } from "@/components/TrackControls";
import { metricDomain, type TrackMetric } from "@/components/TrackOverlay";
import { TrailToggles } from "@/components/TrailToggles";
import { TrackPlayer } from "@/components/TrackPlayer";

export default function Home() {
  const { manifest, loading, error } = useManifest();
  const { track } = useTrack();
  const [active, setActive] = useState<Set<string>>(new Set());
  const [selected, setSelected] = useState<Asset | null>(null);
  const [metric, setMetric] = useState<TrackMetric>("speed");
  const [durRange, setDurRange] = useState<[number, number] | null>(null);
  const [mediaType, setMediaType] = useState<MediaType>("all");
  const [activeTrails, setActiveTrails] = useState<Set<string>>(new Set());
  const [playbackTime, setPlaybackTime] = useState<number | null>(null);

  const hasHr = useMemo(() => !!track?.points.some((p) => p.hr !== undefined), [track]);
  const legendDomain = useMemo(
    () => (track ? metricDomain(track.points, metric) : null),
    [track, metric],
  );

  const apiKey = process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY ?? "";
  const assets = manifest?.assets ?? [];

  const maxDur = useMemo(
    () => Math.ceil(Math.max(0, ...assets.filter((a) => a.type === "video").map((a) => a.durationSec ?? 0))),
    [assets],
  );
  const effRange: [number, number] = durRange ?? [0, maxDur];

  // Apply all active filters; during playback also gate by capture time.
  const visible = useMemo(() => {
    let out = assets;
    if (mediaType !== "all") out = out.filter((a) => a.type === mediaType);
    if (active.size > 0) {
      out = out.filter((a) => LABEL_CATEGORIES.some((c) => a.labels[c].some((v) => active.has(labelKey(c, v)))));
    }
    if (durRange) {
      const [lo, hi] = durRange;
      out = out.filter((a) => a.type !== "video" || a.durationSec === undefined || (a.durationSec >= lo && a.durationSec <= hi));
    }
    if (playbackTime !== null) {
      // Only reveal pins the playback has passed; pins without a timestamp stay hidden.
      out = out.filter((a) => a.capturedAt !== undefined && Date.parse(a.capturedAt) <= playbackTime);
    }
    return out;
  }, [assets, active, durRange, mediaType, playbackTime]);

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
          <div className="map-filters">
            <MediaTypeToggle value={mediaType} onChange={setMediaType} />
            {mediaType !== "photo" && <VideoDurationFilter assets={assets} range={effRange} onChange={setDurRange} />}
          </div>
          {track && track.points.length > 1 && (
            <TrackControls metric={metric} onChange={setMetric} hasHr={hasHr} domain={legendDomain} />
          )}
          {track && track.points.length > 1 && (
            <TrailToggles
              trails={TRAIL_DEFS}
              active={activeTrails}
              onToggle={(id) =>
                setActiveTrails((prev) => {
                  const next = new Set(prev);
                  next.has(id) ? next.delete(id) : next.add(id);
                  return next;
                })
              }
            />
          )}
          {track && track.points.length > 1 && (
            <TrackPlayer track={track} onTime={setPlaybackTime} />
          )}
          <MapView
            assets={visible}
            bounds={manifest?.bounds}
            track={track}
            trackMetric={metric}
            trails={TRAIL_DEFS}
            activeTrails={activeTrails}
            playbackTime={playbackTime}
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
