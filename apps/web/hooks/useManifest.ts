import { useEffect, useState } from "react";
import type { Manifest } from "@gc-media/shared";

interface ManifestState {
  manifest?: Manifest;
  loading: boolean;
  error?: string;
}

/** Fetch the pin manifest at runtime so new pins appear without a redeploy. */
export function useManifest(): ManifestState {
  const [state, setState] = useState<ManifestState>({ loading: true });

  useEffect(() => {
    const url = process.env.NEXT_PUBLIC_MANIFEST_URL;
    if (!url) {
      setState({ loading: false, error: "NEXT_PUBLIC_MANIFEST_URL is not set" });
      return;
    }
    let cancelled = false;
    fetch(url, { cache: "no-store" })
      .then((r) => {
        if (!r.ok) throw new Error(`Manifest fetch failed: ${r.status}`);
        return r.json() as Promise<Manifest>;
      })
      .then((manifest) => !cancelled && setState({ manifest, loading: false }))
      .catch((e: Error) => !cancelled && setState({ loading: false, error: e.message }));
    return () => {
      cancelled = true;
    };
  }, []);

  return state;
}
