import express from "express";
import type { Asset } from "@gc-media/shared";
import { loadPending, savePending } from "../pending.js";
import { loadManifest, saveAndPublish, upsertAssets } from "../manifest.js";
import { State } from "../state.js";

const PAGE = (mapsKey: string, mapId: string) => /* html */ `<!doctype html>
<html><head><meta charset="utf-8"/><title>Place pins</title>
<style>
  body { margin:0; font-family: system-ui, sans-serif; display:flex; height:100vh; }
  #side { width:280px; overflow:auto; border-right:1px solid #ddd; padding:8px; }
  #map { flex:1; }
  .item { border:1px solid #ccc; border-radius:6px; margin:6px 0; padding:6px; cursor:grab; }
  .item img { width:100%; border-radius:4px; }
  .item.done { opacity:.4; }
  h3 { margin:6px 0; font-size:14px; }
</style></head>
<body>
  <div id="side"><h3>Drag a thumbnail onto the map to place it</h3><div id="list"></div></div>
  <div id="map"></div>
  <script>
    let map, dragId = null, markers = {};
    async function load() {
      const items = await (await fetch('/api/pending')).json();
      const list = document.getElementById('list');
      list.innerHTML = '';
      for (const it of items) {
        const el = document.createElement('div');
        el.className = 'item'; el.draggable = true; el.dataset.id = it.id;
        el.innerHTML = '<img src="'+it.thumbnailUrl+'"/><div>'+(it.description||'').slice(0,80)+'</div>';
        el.addEventListener('dragstart', () => dragId = it.id);
        list.appendChild(el);
      }
    }
    function initMap() {
      map = new google.maps.Map(document.getElementById('map'), {
        center: { lat: 36.06, lng: -112.12 }, zoom: 13, mapTypeId: 'terrain', mapId: '${mapId}'
      });
      const div = document.getElementById('map');
      div.addEventListener('dragover', (e) => e.preventDefault());
      div.addEventListener('drop', async (e) => {
        e.preventDefault();
        if (!dragId) return;
        const rect = div.getBoundingClientRect();
        const proj = map.getProjection();
        const ll = pointToLatLng(e.clientX - rect.left, e.clientY - rect.top);
        await fetch('/api/place', { method:'POST', headers:{'content-type':'application/json'},
          body: JSON.stringify({ id: dragId, lat: ll.lat, lng: ll.lng }) });
        dragId = null;
        load();
      });
    }
    function pointToLatLng(x, y) {
      const ne = map.getBounds().getNorthEast(), sw = map.getBounds().getSouthWest();
      const div = document.getElementById('map');
      const lng = sw.lng() + (ne.lng() - sw.lng()) * (x / div.clientWidth);
      const lat = ne.lat() - (ne.lat() - sw.lat()) * (y / div.clientHeight);
      return { lat, lng };
    }
    window.initMap = initMap;
    load();
  </script>
  <script async src="https://maps.googleapis.com/maps/api/js?key=${mapsKey}&callback=initMap&libraries=maps"></script>
</body></html>`;

export async function runPlaceUI(port = 4321): Promise<void> {
  const mapsKey = process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY ?? "";
  const mapId = process.env.NEXT_PUBLIC_GOOGLE_MAPS_MAP_ID ?? "DEMO_MAP_ID";
  if (!mapsKey) {
    console.warn("NEXT_PUBLIC_GOOGLE_MAPS_API_KEY not set — the map will not load.");
  }

  const app = express();
  app.use(express.json());
  app.get("/", (_req, res) => res.send(PAGE(mapsKey, mapId)));
  app.get("/api/pending", async (_req, res) => res.json(await loadPending()));

  app.post("/api/place", async (req, res) => {
    const { id, lat, lng } = req.body as { id: string; lat: number; lng: number };
    const pending = await loadPending();
    const item = pending.find((p) => p.id === id);
    if (!item) return res.status(404).json({ error: "not found" });

    const asset: Asset = { ...item, lat, lng, geoSource: "manual" };
    const manifest = upsertAssets(await loadManifest(), [asset]);
    await saveAndPublish(manifest);

    const state = await State.load();
    const rec = state.get(id);
    if (rec) state.set({ ...rec, geolocated: true });
    await state.save();

    await savePending(pending.filter((p) => p.id !== id));
    res.json({ ok: true });
  });

  app.listen(port, () => {
    console.log(`\nManual placement UI → http://localhost:${port}\n`);
  });
}
