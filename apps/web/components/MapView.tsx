import { useCallback, useEffect, useMemo, useState } from "react";
import { AdvancedMarker, Map, useMap } from "@vis.gl/react-google-maps";
import { MarkerClusterer } from "@googlemaps/markerclusterer";
import type { Asset, MapBounds } from "@gc-media/shared";
import { Pin } from "./Pin";

type MarkerEl = google.maps.marker.AdvancedMarkerElement;

const DEFAULT_CENTER = { lat: 36.06, lng: -112.12 }; // South Rim corridor

function ClusteredPins({ assets, onSelect }: { assets: Asset[]; onSelect: (a: Asset) => void }) {
  const map = useMap();
  const [markers, setMarkers] = useState<Record<string, MarkerEl>>({});

  const clusterer = useMemo(() => {
    if (!map) return null;
    return new MarkerClusterer({ map });
  }, [map]);

  useEffect(() => {
    if (!clusterer) return;
    clusterer.clearMarkers();
    clusterer.addMarkers(Object.values(markers));
  }, [clusterer, markers]);

  const setMarkerRef = useCallback((marker: MarkerEl | null, id: string) => {
    setMarkers((prev) => {
      if ((marker && prev[id]) || (!marker && !prev[id])) return prev;
      if (marker) return { ...prev, [id]: marker };
      const { [id]: _removed, ...rest } = prev;
      return rest;
    });
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
  onSelect: (a: Asset) => void;
}

export function MapView({ assets, bounds, onSelect }: Props) {
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
      <ClusteredPins assets={assets} onSelect={onSelect} />
    </Map>
  );
}
