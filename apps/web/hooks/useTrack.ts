import { useEffect, useState } from "react";
import type { Track } from "@gc-media/shared";

interface TrackState {
  track?: Track;
  loading: boolean;
}

/**
 * Fetch the GPS track for the path overlay. A missing track (no GPX ingested)
 * is not an error — the overlay simply doesn't render.
 */
export function useTrack(): TrackState {
  const [state, setState] = useState<TrackState>({ loading: true });

  useEffect(() => {
    let cancelled = false;
    fetch("/track.json", { cache: "no-store" })
      .then((r) => (r.ok ? (r.json() as Promise<Track>) : undefined))
      .then((track) => !cancelled && setState({ track, loading: false }))
      .catch(() => !cancelled && setState({ loading: false }));
    return () => {
      cancelled = true;
    };
  }, []);

  return state;
}
