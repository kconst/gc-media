import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import express, { type NextFunction, type Request, type Response } from "express";
import multer from "multer";
import type { Asset } from "@gc-media/shared";
import { config } from "../config.js";
import { runPipeline, type RunOptions } from "../pipeline.js";
import { loadPending, savePending } from "../pending.js";
import { loadManifest, removeAsset, saveAndPublish, upsertAssets } from "../manifest.js";
import { State } from "../state.js";

function timingSafeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
}

const page = (mapsKey: string, mapId: string, incomingDir: string) => /* html */ `<!doctype html>
<html><head><meta charset="utf-8"/><title>GC Media — control panel</title>
<style>
  :root { --b:#d0d4da; }
  * { box-sizing:border-box; }
  body { margin:0; font-family:system-ui,sans-serif; color:#1c2127; }
  header { padding:10px 16px; background:#10243e; color:#fff; font-weight:600; }
  main { display:grid; grid-template-columns:380px 1fr; gap:0; height:calc(100vh - 44px); }
  #left { border-right:1px solid var(--b); overflow:auto; padding:14px; }
  #right { display:flex; flex-direction:column; }
  #map { flex:1; min-height:240px; }
  section { margin-bottom:18px; }
  h2 { font-size:13px; text-transform:uppercase; letter-spacing:.04em; color:#5a6473; margin:0 0 8px; }
  label { display:block; font-size:12px; margin:8px 0 2px; color:#3a4350; }
  input[type=text], select { width:100%; padding:6px 8px; border:1px solid var(--b); border-radius:6px; font:inherit; }
  .row { display:flex; gap:14px; align-items:center; margin-top:8px; font-size:13px; }
  button { padding:7px 12px; border:0; border-radius:6px; background:#1f6feb; color:#fff; font:inherit; cursor:pointer; }
  button.secondary { background:#eaecef; color:#1c2127; }
  button:disabled { opacity:.5; cursor:default; }
  pre#log { background:#0d1117; color:#c9d1d9; padding:10px; border-radius:6px; height:180px; overflow:auto; font-size:12px; white-space:pre-wrap; margin-top:10px; }
  .item, .pin { border:1px solid var(--b); border-radius:6px; margin:6px 0; padding:6px; display:flex; gap:8px; align-items:flex-start; }
  .item { cursor:grab; }
  .item img, .pin img { width:64px; height:64px; object-fit:cover; border-radius:4px; flex:0 0 auto; }
  .meta { font-size:12px; overflow:hidden; }
  .meta .src { color:#5a6473; }
  .pin button { background:#cf222e; padding:4px 8px; font-size:12px; margin-top:4px; }
  .empty { color:#8a93a0; font-size:13px; }
  footer { padding:6px 16px; background:#f4f5f7; border-top:1px solid var(--b); font-size:12px; color:#5a6473; }
</style></head>
<body>
<header>Grand Canyon Media — local control panel</header>
<main>
  <div id="left">
    <section>
      <h2>Upload from this device</h2>
      <input id="files" type="file" multiple accept="image/*,video/*"/>
      <div class="row"><button id="upload" class="secondary">Upload</button> <span id="ustatus" class="empty"></span></div>
      <p class="empty" style="margin:6px 0 0">Phone uploads often drop GPS — those land in “Needs placement”.</p>
    </section>
    <section>
      <h2>Ingest</h2>
      <label>Source</label>
      <select id="source">
        <option value="local">Local / uploaded folder</option>
        <option value="google">Google Photos</option>
        <option value="all">All</option>
      </select>
      <label>Folder path (for local)</label>
      <input id="dir" type="text" placeholder="/path/to/media" value="${incomingDir}"/>
      <label>Credit (optional)</label>
      <input id="credit" type="text" placeholder="Your name"/>
      <div class="row">
        <label style="margin:0"><input type="checkbox" id="noai"/> Skip AI</label>
        <label style="margin:0"><input type="checkbox" id="force"/> Reprocess all</label>
      </div>
      <div class="row"><button id="run">Run ingestion</button></div>
      <pre id="log">Idle.</pre>
    </section>
    <section>
      <h2>Needs placement (<span id="pcount">0</span>)</h2>
      <div id="pending"><div class="empty">Nothing pending.</div></div>
    </section>
    <section>
      <h2>Pins on the map (<span id="acount">0</span>)</h2>
      <div id="pins"><div class="empty">No pins yet.</div></div>
    </section>
  </div>
  <div id="right"><div id="map"></div></div>
</main>
<footer>Done ingesting? Stop this instance to avoid charges — AWS Console → EC2 → Instances → Stop. The panel URL stays the same when you start it again.</footer>
<script>
  let map, dragId = null;
  const $ = (id) => document.getElementById(id);

  async function refresh() {
    const [pending, manifest] = await Promise.all([
      fetch('/api/pending').then(r => r.json()),
      fetch('/api/manifest').then(r => r.json()),
    ]);
    renderPending(pending);
    renderPins(manifest.assets || []);
  }

  function renderPending(items) {
    $('pcount').textContent = items.length;
    const box = $('pending');
    if (!items.length) { box.innerHTML = '<div class="empty">Nothing pending.</div>'; return; }
    box.innerHTML = '';
    for (const it of items) {
      const el = document.createElement('div');
      el.className = 'item'; el.draggable = true; el.dataset.id = it.id;
      el.innerHTML = '<img src="'+it.thumbnailUrl+'"/><div class="meta"><b>'+(it.type)+'</b><br/>'+(it.description||'').slice(0,90)+'</div>';
      el.addEventListener('dragstart', () => dragId = it.id);
      box.appendChild(el);
    }
  }

  function renderPins(assets) {
    $('acount').textContent = assets.length;
    const box = $('pins');
    if (!assets.length) { box.innerHTML = '<div class="empty">No pins yet.</div>'; return; }
    box.innerHTML = '';
    for (const a of assets) {
      const el = document.createElement('div');
      el.className = 'pin';
      el.innerHTML = '<img src="'+a.thumbnailUrl+'"/><div class="meta">'+
        (a.description||'').slice(0,80)+'<br/><span class="src">'+a.lat.toFixed(4)+', '+a.lng.toFixed(4)+' · '+a.geoSource+'</span><br/>'+
        '<button data-id="'+a.id+'">Remove</button></div>';
      el.querySelector('button').addEventListener('click', async (e) => {
        if (!confirm('Remove this pin from the map?')) return;
        await fetch('/api/remove', { method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify({ id: e.target.dataset.id }) });
        refresh();
      });
      box.appendChild(el);
    }
  }

  $('upload').addEventListener('click', async () => {
    const inp = $('files');
    if (!inp.files.length) return;
    const fd = new FormData();
    for (const f of inp.files) fd.append('files', f);
    $('ustatus').textContent = 'Uploading…'; $('upload').disabled = true;
    try {
      const r = await fetch('/api/upload', { method:'POST', body: fd }).then(r => r.json());
      $('ustatus').textContent = 'Uploaded ' + r.count + ' file(s).';
      $('dir').value = r.dir; inp.value = '';
    } catch { $('ustatus').textContent = 'Upload failed.'; }
    $('upload').disabled = false;
  });

  $('run').addEventListener('click', () => {
    const params = new URLSearchParams({
      source: $('source').value,
      dir: $('dir').value,
      credit: $('credit').value,
      noAi: $('noai').checked ? '1' : '',
      force: $('force').checked ? '1' : '',
    });
    const log = $('log'); log.textContent = '';
    $('run').disabled = true;
    const es = new EventSource('/api/run?' + params.toString());
    es.onmessage = (e) => { log.textContent += e.data + '\\n'; log.scrollTop = log.scrollHeight; };
    es.addEventListener('done', () => { es.close(); $('run').disabled = false; refresh(); });
    es.onerror = () => { es.close(); $('run').disabled = false; };
  });

  function initMap() {
    map = new google.maps.Map($('map'), { center:{lat:36.06,lng:-112.12}, zoom:12, mapTypeId:'terrain', mapId:'${mapId}' });
    const div = $('map');
    div.addEventListener('dragover', (e) => e.preventDefault());
    div.addEventListener('drop', async (e) => {
      e.preventDefault();
      if (!dragId) return;
      const rect = div.getBoundingClientRect();
      const ll = pointToLatLng(e.clientX - rect.left, e.clientY - rect.top);
      await fetch('/api/place', { method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify({ id: dragId, lat: ll.lat, lng: ll.lng }) });
      dragId = null;
      refresh();
    });
  }
  function pointToLatLng(x, y) {
    const ne = map.getBounds().getNorthEast(), sw = map.getBounds().getSouthWest();
    const div = $('map');
    return { lat: ne.lat() - (ne.lat() - sw.lat()) * (y / div.clientHeight),
             lng: sw.lng() + (ne.lng() - sw.lng()) * (x / div.clientWidth) };
  }
  window.initMap = initMap;
  refresh();
</script>
<script async src="https://maps.googleapis.com/maps/api/js?key=${mapsKey}&callback=initMap&libraries=maps"></script>
</body></html>`;

export async function runServer(port = 4321): Promise<void> {
  const mapsKey = process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY ?? "";
  const mapId = process.env.NEXT_PUBLIC_GOOGLE_MAPS_MAP_ID ?? "DEMO_MAP_ID";
  if (!mapsKey) console.warn("NEXT_PUBLIC_GOOGLE_MAPS_API_KEY not set — the map will not load.");

  const app = express();

  // Basic-auth gate (set PANEL_PASSWORD on the server). No password = open,
  // which is fine for localhost but must be set before exposing the panel.
  const panelUser = process.env.PANEL_USER ?? "gc";
  const panelPassword = process.env.PANEL_PASSWORD;
  if (!panelPassword) {
    console.warn("PANEL_PASSWORD not set — the panel is UNPROTECTED. Set it before exposing this server.");
  }
  app.use((req: Request, res: Response, next: NextFunction) => {
    if (!panelPassword) return next();
    const [scheme, encoded] = (req.headers.authorization ?? "").split(" ");
    if (scheme === "Basic" && encoded) {
      const [user, pass] = Buffer.from(encoded, "base64").toString().split(":");
      if (timingSafeEqual(user ?? "", panelUser) && timingSafeEqual(pass ?? "", panelPassword)) {
        return next();
      }
    }
    res.set("WWW-Authenticate", 'Basic realm="gc-media"').status(401).send("Authentication required.");
  });

  app.use(express.json());

  const upload = multer({
    storage: multer.diskStorage({
      destination: (_req, _file, cb) => {
        fs.mkdir(config.incomingDir, { recursive: true })
          .then(() => cb(null, config.incomingDir))
          .catch((err) => cb(err as Error, config.incomingDir));
      },
      filename: (_req, file, cb) => cb(null, path.basename(file.originalname)),
    }),
  });

  app.get("/", (_req, res) => res.send(page(mapsKey, mapId, config.incomingDir)));

  app.post("/api/upload", upload.array("files"), (req, res) => {
    const files = (req.files as Express.Multer.File[] | undefined) ?? [];
    res.json({ ok: true, count: files.length, dir: config.incomingDir });
  });
  app.get("/api/pending", async (_req, res) => res.json(await loadPending()));
  app.get("/api/manifest", async (_req, res) => res.json(await loadManifest()));

  let running = false;
  app.get("/api/run", async (req, res) => {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });
    const send = (line: string) => res.write(`data: ${line.replace(/\n/g, " ")}\n\n`);
    const done = (status: string) => {
      res.write(`event: done\ndata: ${status}\n\n`);
      res.end();
    };

    if (running) return done("A run is already in progress.");
    const source = (req.query.source as RunOptions["source"]) ?? "local";
    if ((source === "local" || source === "all") && !req.query.dir) {
      send("No folder path provided.");
      return done("error");
    }

    running = true;
    try {
      await runPipeline({
        source,
        dir: req.query.dir ? String(req.query.dir) : undefined,
        credit: req.query.credit ? String(req.query.credit) : undefined,
        force: req.query.force === "1",
        noAi: req.query.noAi === "1",
        log: send,
      });
      done("ok");
    } catch (err) {
      send(`ERROR: ${(err as Error).message}`);
      done("error");
    } finally {
      running = false;
    }
  });

  app.post("/api/place", async (req, res) => {
    const { id, lat, lng } = req.body as { id: string; lat: number; lng: number };
    const pending = await loadPending();
    const item = pending.find((p) => p.id === id);
    if (!item) return res.status(404).json({ error: "not found" });

    const asset: Asset = { ...item, lat, lng, geoSource: "manual" };
    await saveAndPublish(upsertAssets(await loadManifest(), [asset]));

    const state = await State.load();
    const rec = state.get(id);
    if (rec) state.set({ ...rec, geolocated: true });
    await state.save();

    await savePending(pending.filter((p) => p.id !== id));
    res.json({ ok: true });
  });

  app.post("/api/remove", async (req, res) => {
    const { id } = req.body as { id: string };
    await saveAndPublish(removeAsset(await loadManifest(), id));
    const state = await State.load();
    state.remove(id);
    await state.save();
    res.json({ ok: true });
  });

  app.listen(port, () => {
    console.log(`\nControl panel → http://localhost:${port}\n`);
  });
}
