import { useCallback, useEffect, useMemo, useRef } from "react";
import { AdvancedMarker, Map, useMap } from "@vis.gl/react-google-maps";
import { MarkerClusterer } from "@googlemaps/markerclusterer";
import type { Asset, MapBounds, Track } from "@gc-media/shared";
import { Pin } from "./Pin";
import { TrackOverlay, type TrackMetric } from "./TrackOverlay";
import { MeasureControl } from "./MeasureControl";

type MarkerEl = google.maps.marker.AdvancedMarkerElement;

const DEFAULT_CENTER = { lat: 36.06, lng: -112.12 }; // South Rim corridor

function ClusteredPins({ assets, onSelect }: { assets: Asset[]; onSelect: (a: Asset) => void }) {
  const map = useMap();
  // Track marker elements in a ref (not state) so attaching refs never triggers
  // a re-render — an inline ref callback re-runs every render, and updating
  // state from it caused an infinite loop (React #185).
  const markersRef = useRef<Record<string, MarkerEl>>({});

  const clusterer = useMemo(() => {
    if (!map) return null;
    return new MarkerClusterer({ map });
  }, [map]);

  // Sync the clusterer after render (refs have committed by now). Keyed on the
  // visible asset set so it re-syncs when the manifest loads or filters change.
  useEffect(() => {
    if (!clusterer) return;
    clusterer.clearMarkers();
    clusterer.addMarkers(Object.values(markersRef.current));
  }, [clusterer, assets]);

  useEffect(() => () => clusterer?.clearMarkers(), [clusterer]);

  const setMarkerRef = useCallback((marker: MarkerEl | null, id: string) => {
    if (marker) markersRef.current[id] = marker;
    else delete markersRef.current[id];
  }, []);

  return (
    <>
      {assets.map((a) => (
        <AdvancedMarker
          key={a.id}
          position={{ lat: a.lat, lng: a.lng }}
          ref={(m) => setMarkerRef(m, a.id)}
          onClick={() => onSelect(a)}
        >
          <Pin asset={a} />
        </AdvancedMarker>
      ))}
    </>
  );
}

interface Props {
  assets: Asset[];
  bounds?: MapBounds;
  track?: Track;
  trackMetric: TrackMetric;
  onSelect: (a: Asset) => void;
}

export function MapView({ assets, bounds, track, trackMetric, onSelect }: Props) {
  const mapId = process.env.NEXT_PUBLIC_GOOGLE_MAPS_MAP_ID ?? "DEMO_MAP_ID";

  return (
    <Map
      className="map"
      mapId={mapId}
      defaultCenter={DEFAULT_CENTER}
      defaultZoom={13}
      defaultBounds={
        bounds
          ? {
              north: bounds.north,
              south: bounds.south,
              east: bounds.east,
              west: bounds.west,
            }
          : undefined
      }
      mapTypeId="terrain"
      gestureHandling="greedy"
      mapTypeControl
      disableDefaultUI={false}
    >
      {track && <TrackOverlay track={track} metric={trackMetric} />}
      {track && <MeasureControl track={track} assets={assets} />}
      <ClusteredPins assets={assets} onSelect={onSelect} />
    </Map>
  );
}
