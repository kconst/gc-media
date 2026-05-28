import { useEffect, useMemo, useRef } from "react";
import { useMap } from "@vis.gl/react-google-maps";
import type { Track } from "@gc-media/shared";
import { indexAtTime } from "./TrackPlayer";

export function PlaybackTrackOverlay({ track, time }: { track: Track; time: number }) {
  const map = useMap();

  // Pre-build the full path array once so slice() doesn't recreate objects.
  const fullPath = useMemo(
    () => track.points.map((p) => ({ lat: p.lat, lng: p.lng })),
    [track],
  );

  // Hold the Google Maps objects in refs so we never recreate them.
  const playedRef   = useRef<google.maps.Polyline | null>(null);
  const unplayedRef = useRef<google.maps.Polyline | null>(null);
  const markerRef   = useRef<google.maps.marker.AdvancedMarkerElement | null>(null);
  const lastIdxRef  = useRef<number>(-1);

  // Create once when the map is ready.
  useEffect(() => {
    if (!map) return;

    const played = new google.maps.Polyline({
      strokeColor: "#1a73e8",
      strokeOpacity: 0.92,
      strokeWeight: 5,
      zIndex: 4,
      map,
    });
    const unplayed = new google.maps.Polyline({
      strokeColor: "#888",
      strokeOpacity: 0.2,
      strokeWeight: 3,
      zIndex: 3,
      map,
    });
    const dot = document.createElement("div");
    dot.className = "playback-dot";
    const marker = new google.maps.marker.AdvancedMarkerElement({
      map,
      content: dot,
      zIndex: 10,
    });

    playedRef.current   = played;
    unplayedRef.current = unplayed;
    markerRef.current   = marker;
    lastIdxRef.current  = -1;

    return () => {
      played.setMap(null);
      unplayed.setMap(null);
      marker.map = undefined;
      playedRef.current   = null;
      unplayedRef.current = null;
      markerRef.current   = null;
    };
  }, [map]);

  // Update paths only when the track-point index changes (not every animation frame).
  useEffect(() => {
    if (!playedRef.current || !unplayedRef.current || !markerRef.current) return;

    const idx = indexAtTime(track.points, time);
    if (idx === lastIdxRef.current) return; // nothing changed
    lastIdxRef.current = idx;

    const cur = track.points[idx]!;
    playedRef.current.setPath(fullPath.slice(0, idx + 1));
    unplayedRef.current.setPath(fullPath.slice(idx));
    markerRef.current.position = { lat: cur.lat, lng: cur.lng };
  }, [track, time, fullPath]);

  return null;
}
