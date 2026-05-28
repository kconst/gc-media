import crypto from "node:crypto";
import fs from "node:fs/promises";
import { createWriteStream } from "node:fs";
import path from "node:path";
import express, { type NextFunction, type Request, type Response } from "express";
import multer from "multer";
import unzipper from "unzipper";
import type { Asset } from "@gc-media/shared";
import { config } from "../config.js";
import { runPipeline, runPipelineOnItems, type RunOptions } from "../pipeline.js";
import { listGoproMedia, downloadGoproMedia } from "../sources/gopro.js";
import { icloudToken, listIcloudAssets, icloudItems, icloudUrls, downloadIcloudItem } from "../sources/icloud.js";
import { loadPending, savePending } from "../pending.js";
import { loadManifest, removeAsset, saveAndPublish, upsertAssets } from "../manifest.js";
import { State } from "../state.js";
import { listGpxFiles, loadGpxTracks } from "../meta/gpx.js";
import { readVideoDuration } from "../meta/videoTime.js";
import { GeoResolver } from "../geo/resolver.js";

function timingSafeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
}

const MEDIA_EXT = new Set([".jpg", ".jpeg", ".png", ".heic", ".heif", ".webp", ".mp4", ".mov", ".m4v", ".avi"]);

/** Keep media files, Takeout JSON sidecars, and GPX tracks; drop the rest. */
function wantedInZip(name: string): boolean {
  const lower = name.toLowerCase();
  return lower.endsWith(".json") || lower.endsWith(".gpx") || MEDIA_EXT.has(path.extname(lower));
}

/**
 * Extract media + sidecars from a (Google Takeout) zip into destDir, preserving
 * each entry's relative folder so images and their .json sidecars stay together.
 * Guards against zip-slip path traversal.
 */
async function extractMediaZip(zipPath: string, destDir: string): Promise<number> {
  await fs.mkdir(destDir, { recursive: true });
  const root = path.resolve(destDir);
  const directory = await unzipper.Open.file(zipPath);
  let count = 0;
  for (const entry of directory.files) {
    if (entry.type !== "File" || !wantedInZip(entry.path)) continue;
    const outPath = path.resolve(root, entry.path);
    if (outPath !== root && !outPath.startsWith(root + path.sep)) continue; // zip-slip
    await fs.mkdir(path.dirname(outPath), { recursive: true });
    await new Promise<void>((resolve, reject) => {
      entry
        .stream()
        .pipe(createWriteStream(outPath))
        .on("finish", () => resolve())
        .on("error", reject);
    });
    count++;
  }
  return count;
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
  .geo { display:flex; gap:6px; margin-top:6px; }
  .geo input { flex:1; min-width:0; padding:4px 6px; border:1px solid var(--b); border-radius:6px; font:inherit; font-size:12px; }
  .geo button { padding:4px 8px; font-size:12px; }
  .pin button.remove { background:#cf222e; padding:4px 8px; font-size:12px; margin-top:4px; }
  .empty { color:#8a93a0; font-size:13px; }
  footer { padding:6px 16px; background:#f4f5f7; border-top:1px solid var(--b); font-size:12px; color:#5a6473; }
</style></head>
<body>
<header>Grand Canyon Media — local control panel</header>
<main>
  <div id="left">
    <section>
      <h2>Upload from this device</h2>
      <input id="files" type="file" multiple accept="image/*,video/*,.gpx"/>
      <div class="row"><button id="upload" class="secondary">Upload</button> <span id="ustatus" class="empty"></span></div>
      <p class="empty" style="margin:6px 0 0">Add a Garmin .gpx track to place GPS-less videos by timestamp.</p>
    </section>
    <section>
      <h2>GPS tracks (<span id="tcount">0</span>)</h2>
      <div id="tracks"><div class="empty">No tracks uploaded.</div></div>
    </section>
    <section>
      <h2>Upload Google Takeout (.zip)</h2>
      <input id="zip" type="file" accept=".zip,application/zip"/>
      <div class="row"><button id="uploadzip" class="secondary">Upload &amp; extract</button> <span id="zstatus" class="empty"></span></div>
      <p class="empty" style="margin:6px 0 0">Keeps GPS from the .json sidecars, so pins auto-place.</p>
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
      <label>GPX time offset (minutes) — shift camera clock to match the track</label>
      <input id="offset" type="number" value="0" step="1"/>
      <div class="row"><button id="run">Run ingestion</button></div>
      <pre id="log">Idle.</pre>
    </section>
    <section>
      <h2>Import from GoPro Cloud</h2>
      <p class="empty" style="margin:0 0 6px">Paste your gp_access_token (gopro.com cookie / DevTools). Pulls each clip's real recording time and places it on the GPX track by filename.</p>
      <input id="gptoken" type="password" placeholder="token (eyJ…)"/>
      <div class="row">
        <button id="gpingest">Download &amp; ingest all</button>
        <button id="gpimport" class="secondary">Import times only</button>
        <span id="gpstatus" class="empty"></span>
      </div>
      <p class="empty" style="margin:6px 0 0"><b>Download &amp; ingest</b>: pull every clip from GoPro Cloud, transcode, and place by time (progress shows in the ingestion log). <b>Import times only</b>: place clips you already uploaded.</p>
      <pre id="gplog" style="display:none"></pre>
    </section>
    <section>
      <h2>Import iCloud Shared Album</h2>
      <p class="empty" style="margin:0 0 6px">Paste the public album link. Only items within the GPX time window are imported; each is placed by time-match on the track (like GoPro).</p>
      <input id="icurl" type="text" placeholder="https://www.icloud.com/sharedalbum/#…"/>
      <label>Time offset (minutes) — normalize album time to the track</label>
      <input id="icoffset" type="number" value="0" step="1"/>
      <div class="row"><button id="icimport" class="secondary">Import album</button> <span id="icstatus" class="empty"></span></div>
    </section>
    <section>
      <h2>Bulk place by timestamps</h2>
      <p class="empty" style="margin:0 0 6px">Upload a JSON of filename → recording time (from GoPro Cloud). Times use this browser's timezone. Pins land on the GPX track at each time.</p>
      <input id="bulkjson" type="file" accept=".json,application/json"/>
      <textarea id="bulktext" rows="4" placeholder='{"GX010055.MP4": "May 19, 2026 2:44 PM"}  — or paste here instead of a file' style="width:100%;font:inherit;border:1px solid var(--b);border-radius:6px;padding:6px;margin-top:6px"></textarea>
      <div class="row"><button id="bulkplace" class="secondary">Place from JSON</button> <span id="bulkstatus" class="empty"></span></div>
      <pre id="bulklog" style="display:none"></pre>
    </section>
    <section>
      <h2>Needs placement (<span id="pcount">0</span>)</h2>
      <div class="row"><button id="placeall" class="secondary">Place all by time</button> <span id="pastatus" class="empty"></span></div>
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
    const [pending, manifest, tracks] = await Promise.all([
      fetch('/api/pending').then(r => r.json()),
      fetch('/api/manifest').then(r => r.json()),
      fetch('/api/tracks').then(r => r.json()),
    ]);
    renderPending(pending);
    renderPins(manifest.assets || []);
    renderTracks(tracks || []);
  }

  function fmtLocal(ms) {
    return new Date(ms).toLocaleString([], { month:'short', day:'numeric', hour:'numeric', minute:'2-digit' });
  }
  function fmtRange(start, end) {
    if (!start) return '';
    if (!end || end === start) return fmtLocal(start);
    const s = new Date(start), e = new Date(end);
    const endStr = s.toDateString() === e.toDateString()
      ? e.toLocaleTimeString([], { hour:'numeric', minute:'2-digit' })
      : fmtLocal(end);
    return fmtLocal(start) + ' – ' + endStr;
  }

  function renderTracks(tracks) {
    $('tcount').textContent = tracks.length;
    const box = $('tracks');
    if (!tracks.length) { box.innerHTML = '<div class="empty">No tracks uploaded.</div>'; return; }
    box.innerHTML = '';
    let lo = Infinity, hi = -Infinity;
    for (const t of tracks) {
      if (t.start) lo = Math.min(lo, t.start);
      if (t.end) hi = Math.max(hi, t.end);
      const el = document.createElement('div');
      el.className = 'pin';
      el.innerHTML = '<div class="meta"><b>'+t.name+'</b><br/>'+
        '<span class="src">'+t.points+' pts · '+fmtRange(t.start, t.end)+(t.hasHr ? ' · HR' : '')+'</span><br/>'+
        '<button class="remove">Remove</button></div>';
      el.querySelector('.remove').addEventListener('click', async () => {
        if (!confirm('Remove track "'+t.name+'"? It will no longer place videos.')) return;
        await fetch('/api/tracks/remove', { method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify({ path: t.path }) });
        refresh();
      });
      box.appendChild(el);
    }
  }

  function renderPending(items) {
    $('pcount').textContent = items.length;
    const box = $('pending');
    if (!items.length) { box.innerHTML = '<div class="empty">Nothing pending.</div>'; return; }
    box.innerHTML = '';
    for (const it of items) {
      const el = document.createElement('div');
      el.className = 'item'; el.draggable = true; el.dataset.id = it.id;
      el.innerHTML = '<img src="'+it.thumbnailUrl+'"/><div class="meta"><b>'+(it.type)+'</b><br/>'+(it.description||'').slice(0,90)+
        '<div class="geo"><input class="ll" placeholder="lat, lng"/><button class="secondary place">Place</button></div>'+
        '<div class="geo"><input class="ts" type="datetime-local"/><button class="secondary placetime" title="Find this time on the GPX track">By time</button></div></div>';
      el.addEventListener('dragstart', () => dragId = it.id);
      const inp = el.querySelector('.ll');
      const ts = el.querySelector('.ts');
      for (const f of [inp, ts]) { // let fields be edited without starting a drag
        f.draggable = false;
        f.addEventListener('mousedown', (e) => e.stopPropagation());
      }
      el.querySelector('.place').addEventListener('click', async () => {
        const ll = parseLatLng(inp.value);
        if (!ll) { alert('Enter coordinates as "lat, lng", e.g. 36.0501, -112.1201'); return; }
        await fetch('/api/place', { method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify({ id: it.id, lat: ll.lat, lng: ll.lng }) });
        refresh();
      });
      el.querySelector('.placetime').addEventListener('click', async () => {
        if (!ts.value) { alert('Pick the recording date & time (read it from GoPro Cloud).'); return; }
        const t = new Date(ts.value).getTime(); // datetime-local parsed in the browser timezone
        if (!isFinite(t)) { alert('Invalid date/time.'); return; }
        const j = await fetch('/api/place-by-time', { method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify({ id: it.id, t }) }).then(r => r.json());
        if (!j.ok) { alert(j.error || 'Could not place by time.'); return; }
        refresh();
      });
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
        (a.description||'').slice(0,80)+'<br/><span class="src">'+a.lat.toFixed(4)+', '+a.lng.toFixed(4)+' · '+a.geoSource+'</span>'+
        '<div class="geo"><input class="ll" value="'+a.lat.toFixed(6)+', '+a.lng.toFixed(6)+'"/><button class="secondary move">Move</button></div>'+
        '<button class="remove" data-id="'+a.id+'">Remove</button></div>';
      el.querySelector('.move').addEventListener('click', async () => {
        const ll = parseLatLng(el.querySelector('.ll').value);
        if (!ll) { alert('Enter coordinates as "lat, lng", e.g. 36.0501, -112.1201'); return; }
        await fetch('/api/move', { method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify({ id: a.id, lat: ll.lat, lng: ll.lng }) });
        refresh();
      });
      el.querySelector('.remove').addEventListener('click', async (e) => {
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
      refresh(); // surface any newly uploaded .gpx in the tracks list
    } catch { $('ustatus').textContent = 'Upload failed.'; }
    $('upload').disabled = false;
  });

  $('uploadzip').addEventListener('click', async () => {
    const inp = $('zip');
    if (!inp.files.length) return;
    const fd = new FormData();
    fd.append('zip', inp.files[0]);
    $('zstatus').textContent = 'Uploading & extracting…'; $('uploadzip').disabled = true;
    try {
      const r = await fetch('/api/upload-zip', { method:'POST', body: fd }).then(r => r.json());
      if (r.ok) { $('zstatus').textContent = 'Extracted ' + r.count + ' file(s).'; $('dir').value = r.dir; }
      else $('zstatus').textContent = 'Failed: ' + (r.error || 'error');
    } catch { $('zstatus').textContent = 'Upload failed.'; }
    inp.value = ''; $('uploadzip').disabled = false;
  });

  // Accept either {"file.MP4":"<time>"} or [{filename,timestamp}] and convert
  // each time to an epoch using this browser's timezone (same as "By time").
  function parseBulk(text) {
    const data = JSON.parse(text);
    const rows = Array.isArray(data)
      ? data.map(e => [e.filename || e.name || e.file, e.timestamp || e.time || e.date || e.capturedAt])
      : Object.entries(data);
    const items = []; const bad = [];
    for (const [filename, ts] of rows) {
      const t = new Date(ts).getTime();
      if (filename && isFinite(t)) items.push({ filename, t });
      else bad.push(filename || '(unnamed)');
    }
    return { items, bad };
  }

  $('bulkplace').addEventListener('click', async () => {
    const fileInp = $('bulkjson');
    let text = $('bulktext').value.trim();
    if (!text && fileInp.files.length) text = await fileInp.files[0].text();
    if (!text) { $('bulkstatus').textContent = 'Choose a JSON file or paste JSON.'; return; }
    let parsed;
    try { parsed = parseBulk(text); }
    catch (e) { $('bulkstatus').textContent = 'Invalid JSON.'; return; }
    if (!parsed.items.length) { $('bulkstatus').textContent = 'No valid filename/time entries found.'; return; }
    $('bulkplace').disabled = true; $('bulkstatus').textContent = 'Placing ' + parsed.items.length + '…';
    try {
      const j = await fetch('/api/place-bulk', { method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify({ items: parsed.items }) }).then(r => r.json());
      if (!j.ok) { $('bulkstatus').textContent = j.error || 'Failed.'; $('bulkplace').disabled = false; return; }
      $('bulkstatus').textContent = 'Placed ' + j.placed + ' of ' + j.total + '.';
      const notPlaced = (j.results || []).filter(r => r.status !== 'placed');
      const log = $('bulklog');
      log.style.display = notPlaced.length ? 'block' : 'none';
      log.textContent = notPlaced.map(r => r.filename + ' — ' + r.status).join('\\n')
        + (parsed.bad.length ? '\\nunparseable times: ' + parsed.bad.join(', ') : '');
      refresh();
    } catch { $('bulkstatus').textContent = 'Request failed.'; }
    $('bulkplace').disabled = false;
  });

  $('gpingest').addEventListener('click', async () => {
    const token = $('gptoken').value.trim();
    if (!token) { $('gpstatus').textContent = 'Paste your GoPro token first.'; return; }
    if (!confirm('Download and ingest ALL clips from GoPro Cloud? This can take a while.')) return;
    $('gpstatus').textContent = 'Started — watch the ingestion log below.';
    try {
      const j = await fetch('/api/gopro-ingest', { method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify({ token, noAi: $('noai').checked }) }).then(r => r.json());
      if (j.active) { $('gpstatus').textContent = 'A run is already in progress.'; return; }
      if (!j.ok) { $('gpstatus').textContent = j.error || 'Failed to start.'; return; }
      $('gptoken').value = '';
      pollLog();
    } catch { $('gpstatus').textContent = 'Request failed.'; }
  });

  $('gpimport').addEventListener('click', async () => {
    const token = $('gptoken').value.trim();
    if (!token) { $('gpstatus').textContent = 'Paste your GoPro token first.'; return; }
    $('gpimport').disabled = true; $('gpstatus').textContent = 'Fetching from GoPro Cloud…';
    try {
      const j = await fetch('/api/gopro-import', { method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify({ token }) }).then(r => r.json());
      if (!j.ok) { $('gpstatus').textContent = j.error || 'Import failed.'; $('gpimport').disabled = false; return; }
      $('gpstatus').textContent = 'Fetched ' + j.fetched + ' clips · placed ' + j.placed + ' of ' + j.total + '.';
      const notPlaced = (j.results || []).filter(r => r.status !== 'placed');
      const log = $('gplog');
      log.style.display = notPlaced.length ? 'block' : 'none';
      log.textContent = notPlaced.map(r => r.filename + ' — ' + r.status).join('\\n');
      $('gptoken').value = '';
      refresh();
    } catch { $('gpstatus').textContent = 'Request failed.'; }
    $('gpimport').disabled = false;
  });

  $('placeall').addEventListener('click', async () => {
    if (!confirm('Time-match every pending item against the GPX track and place those within ~15 min of the route?')) return;
    $('pastatus').textContent = 'Placing…'; $('placeall').disabled = true;
    try {
      const j = await fetch('/api/place-pending-by-time', { method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify({ timeOffsetMinutes: Number($('offset').value)||0 }) }).then(r => r.json());
      if (!j.ok) { $('pastatus').textContent = j.error || 'Failed.'; }
      else { $('pastatus').textContent = 'Placed ' + j.placed + ' of ' + j.total + ' (' + j.noMatch + ' off-track, ' + j.noTime + ' undated).'; }
      refresh();
    } catch { $('pastatus').textContent = 'Request failed.'; }
    $('placeall').disabled = false;
  });

  $('icimport').addEventListener('click', async () => {
    const url = $('icurl').value.trim();
    if (!url) { $('icstatus').textContent = 'Paste the album link first.'; return; }
    if (!confirm('Import iCloud album items within the GPX window?')) return;
    $('icstatus').textContent = 'Started — watch the ingestion log below.';
    try {
      const j = await fetch('/api/icloud-ingest', { method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify({ url, timeOffsetMinutes: Number($('icoffset').value)||0, noAi: $('noai').checked }) }).then(r => r.json());
      if (j.active) { $('icstatus').textContent = 'A run is already in progress.'; return; }
      if (!j.ok) { $('icstatus').textContent = j.error || 'Failed to start.'; return; }
      pollLog();
    } catch { $('icstatus').textContent = 'Request failed.'; }
  });

  let logCursor = 0;
  function appendLog(line) {
    const log = $('log');
    log.textContent += line + '\\n';
    log.scrollTop = log.scrollHeight;
  }
  async function pollLog() {
    let r;
    try { r = await fetch('/api/run/log?from=' + logCursor).then(r => r.json()); }
    catch { setTimeout(pollLog, 1500); return; }
    for (const l of r.lines) appendLog(l);
    logCursor = r.total;
    if (r.active) { $('run').disabled = true; setTimeout(pollLog, 1200); }
    else { $('run').disabled = false; refresh(); }
  }

  $('run').addEventListener('click', async () => {
    $('log').textContent = ''; logCursor = 0; $('run').disabled = true;
    try {
      await fetch('/api/run', {
        method:'POST', headers:{'content-type':'application/json'},
        body: JSON.stringify({
          source: $('source').value, dir: $('dir').value, credit: $('credit').value,
          noAi: $('noai').checked, force: $('force').checked,
          timeOffsetMinutes: Number($('offset').value) || 0,
        }),
      });
    } catch { appendLog('Could not start run.'); $('run').disabled = false; return; }
    pollLog();
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
  function parseLatLng(s) {
    const m = String(s).trim().match(/^(-?\\d+(?:\\.\\d+)?)\\s*[, ]\\s*(-?\\d+(?:\\.\\d+)?)$/);
    if (!m) return null;
    const lat = parseFloat(m[1]), lng = parseFloat(m[2]);
    if (!isFinite(lat) || !isFinite(lng) || lat < -90 || lat > 90 || lng < -180 || lng > 180) return null;
    return { lat, lng };
  }
  function pointToLatLng(x, y) {
    const ne = map.getBounds().getNorthEast(), sw = map.getBounds().getSouthWest();
    const div = $('map');
    return { lat: ne.lat() - (ne.lat() - sw.lat()) * (y / div.clientHeight),
             lng: sw.lng() + (ne.lng() - sw.lng()) * (x / div.clientWidth) };
  }
  window.initMap = initMap;
  refresh();
  pollLog(); // resume an in-progress run's log after a refresh
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

  const uploadZip = multer({ dest: path.join(config.cacheDir, "uploads") });
  app.post("/api/upload-zip", uploadZip.single("zip"), async (req, res) => {
    const file = req.file;
    if (!file) return res.status(400).json({ error: "no file" });
    try {
      const count = await extractMediaZip(file.path, config.incomingDir);
      res.json({ ok: true, count, dir: config.incomingDir });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    } finally {
      fs.unlink(file.path).catch(() => {});
    }
  });
  app.get("/api/pending", async (_req, res) => res.json(await loadPending()));
  app.get("/api/manifest", async (_req, res) => res.json(await loadManifest()));
  app.get("/api/tracks", async (_req, res) => res.json(await listGpxFiles(config.incomingDir)));

  app.post("/api/tracks/remove", async (req, res) => {
    const rel = String((req.body as { path?: string }).path ?? "");
    const base = path.resolve(config.incomingDir);
    const full = path.resolve(base, rel);
    // Confine deletes to .gpx files inside the incoming dir (no path traversal).
    if ((full !== base && !full.startsWith(base + path.sep)) || !full.toLowerCase().endsWith(".gpx")) {
      return res.status(400).json({ error: "invalid path" });
    }
    await fs.unlink(full).catch(() => {});
    res.json({ ok: true });
  });

  // Run state is buffered server-side and polled by the client, so progress
  // survives page refreshes and an in-progress run is visible from any load.
  let runActive = false;
  let runLog: string[] = [];
  const pushLog = (line: string) => {
    runLog.push(line);
    if (runLog.length > 5000) runLog.shift();
  };

  app.post("/api/run", (req, res) => {
    if (runActive) return res.json({ ok: false, active: true });
    const body = req.body as {
      source?: RunOptions["source"];
      dir?: string;
      credit?: string;
      noAi?: boolean;
      force?: boolean;
      timeOffsetMinutes?: number;
    };
    const source = body.source ?? "local";

    runActive = true;
    runLog = [];
    if ((source === "local" || source === "all") && !body.dir) {
      pushLog("No folder path provided.");
      runActive = false;
      return res.json({ ok: false, error: "no dir" });
    }
    pushLog(`Starting ${source} ingestion${body.dir ? ` from ${body.dir}` : ""}…`);

    runPipeline({
      source,
      dir: body.dir || undefined,
      credit: body.credit || undefined,
      force: !!body.force,
      noAi: !!body.noAi,
      timeOffsetMinutes: body.timeOffsetMinutes || 0,
      log: pushLog,
    })
      .then(() => pushLog("Done."))
      .catch((err) => pushLog(`ERROR: ${(err as Error).message}`))
      .finally(() => {
        runActive = false;
      });

    res.json({ ok: true });
  });

  // Download every clip from GoPro Cloud and ingest it, a few at a time so the
  // disk never fills. Reuses the run-log channel so the panel shows progress.
  app.post("/api/gopro-ingest", (req, res) => {
    if (runActive) return res.json({ ok: false, active: true });
    const body = req.body as { token?: string; noAi?: boolean; limit?: number; maxGb?: number };
    const token = body.token?.trim().replace(/^Bearer\s+/i, "");
    if (!token) return res.status(400).json({ error: "no token" });
    const limit = Number(body.limit) > 0 ? Number(body.limit) : undefined;
    // Per-run download cap override (e.g. lift it for the giant-clip pass).
    const maxBytes = Number(body.maxGb) > 0 ? Number(body.maxGb) * 1024 ** 3 : undefined;

    runActive = true;
    runLog = [];
    pushLog("Listing GoPro Cloud media…");

    (async () => {
      let media = await listGoproMedia(token);
      // Resumable: skip clips already on the map or pending (by filename), so a
      // re-run with a fresh token continues instead of re-downloading.
      const manifest = await loadManifest();
      const pending = await loadPending();
      const known = new Set(
        [...manifest.assets, ...pending]
          .map((a) => a.originalFilename?.toLowerCase())
          .filter(Boolean) as string[],
      );
      const before = media.length;
      media = media.filter((m) => !known.has(path.basename(m.filename).toLowerCase()));
      if (limit) media = media.slice(0, limit);
      pushLog(`Found ${before} clips; ${media.length} new to ingest (skipping ${before - media.length} already done).`);
      // One at a time: GoPro originals can be multi-GB, so keep peak disk low.
      const BATCH = 1;
      for (let i = 0; i < media.length; i += BATCH) {
        const batch = media.slice(i, i + BATCH);
        const items = [];
        for (const m of batch) {
          try {
            pushLog(`Downloading ${m.filename}…`);
            items.push(await downloadGoproMedia(token, m, config.incomingDir, maxBytes));
          } catch (e) {
            pushLog(`  FAILED download ${m.filename}: ${(e as Error).message}`);
          }
        }
        if (items.length) {
          try {
            await runPipelineOnItems(items, { source: "local", noAi: !!body.noAi, log: pushLog });
          } finally {
            // Always reclaim the downloaded originals, even if processing threw.
            for (const it of items) await fs.unlink(it.localPath).catch(() => {});
          }
        }
        pushLog(`Progress: ${Math.min(i + BATCH, media.length)}/${media.length}`);
      }
      pushLog("GoPro ingest complete.");
    })()
      .catch((e) => pushLog(`ERROR: ${(e as Error).message}`))
      .finally(() => {
        runActive = false;
      });

    res.json({ ok: true });
  });

  // One-time import of an iCloud shared album, placed by GPX time-match (same
  // as GoPro). Filters to the GPX time window so only on-trip media is pulled.
  app.post("/api/icloud-ingest", (req, res) => {
    if (runActive) return res.json({ ok: false, active: true });
    const body = req.body as { url?: string; timeOffsetMinutes?: number; allItems?: boolean; noAi?: boolean };
    const token = body.url ? icloudToken(body.url) : "";
    if (!token) return res.status(400).json({ error: "no album url" });
    const offMs = (Number(body.timeOffsetMinutes) || 0) * 60_000;

    runActive = true;
    runLog = [];
    pushLog("Reading iCloud shared album…");

    (async () => {
      const { host, photos } = await listIcloudAssets(token);
      let items = icloudItems(photos);
      pushLog(`Album has ${items.length} datable items.`);

      const track = await loadGpxTracks(config.incomingDir);
      if (!body.allItems && track.length) {
        const ts = track.map((p) => p.t);
        const start = Math.min(...ts);
        const end = Math.max(...ts);
        const before = items.length;
        items = items.filter((i) => i.capturedAt + offMs >= start && i.capturedAt + offMs <= end);
        pushLog(`Within GPX window (offset ${body.timeOffsetMinutes || 0}m): ${items.length} of ${before}.`);
      } else if (!body.allItems) {
        pushLog("No GPX track found — importing all items.");
      }

      const urls = await icloudUrls(host, token, items);
      const BATCH = 6;
      for (let i = 0; i < items.length; i += BATCH) {
        const batch = items.slice(i, i + BATCH);
        const ing = [];
        for (const it of batch) {
          const url = urls.get(it.checksum);
          if (!url) {
            pushLog(`  no URL for ${it.guid.slice(0, 8)}`);
            continue;
          }
          try {
            pushLog(`Downloading ${it.type} ${it.guid.slice(0, 8)}…`);
            ing.push(await downloadIcloudItem(url, it, config.incomingDir));
          } catch (e) {
            pushLog(`  FAILED ${it.guid.slice(0, 8)}: ${(e as Error).message}`);
          }
        }
        if (ing.length) {
          try {
            await runPipelineOnItems(ing, {
              source: "local",
              noAi: !!body.noAi,
              timeOffsetMinutes: body.timeOffsetMinutes || 0,
              log: pushLog,
            });
          } finally {
            for (const x of ing) await fs.unlink(x.localPath).catch(() => {});
          }
        }
        pushLog(`Progress: ${Math.min(i + BATCH, items.length)}/${items.length}`);
      }
      pushLog("iCloud import complete.");
    })()
      .catch((e) => pushLog(`ERROR: ${(e as Error).message}`))
      .finally(() => {
        runActive = false;
      });

    res.json({ ok: true });
  });

  app.get("/api/run/log", (req, res) => {
    const from = Math.max(0, Number(req.query.from) || 0);
    res.json({ from, lines: runLog.slice(from), total: runLog.length, active: runActive });
  });

  // Move a pending item onto the map: publish it as a pin and drop it from the
  // pending queue. Returns false if the id is no longer pending.
  async function commitPlacement(
    id: string,
    lat: number,
    lng: number,
    source: Asset["geoSource"],
  ): Promise<boolean> {
    const pending = await loadPending();
    const item = pending.find((p) => p.id === id);
    if (!item) return false;

    const asset: Asset = { ...item, lat, lng, geoSource: source };
    await saveAndPublish(upsertAssets(await loadManifest(), [asset]));

    const state = await State.load();
    const rec = state.get(id);
    if (rec) state.set({ ...rec, geolocated: true });
    await state.save();

    await savePending(pending.filter((p) => p.id !== id));
    return true;
  }

  // Match {filename, t(epoch ms)} entries to pending clips, look each up on the
  // GPX track, and publish all matches in one pass. Shared by the JSON-paste
  // and GoPro-Cloud import paths.
  async function bulkPlaceByTime(
    items: { filename: string; t: number }[],
  ): Promise<{ placed: number; total: number; results: { filename: string; status: string }[] } | { error: string }> {
    const track = await loadGpxTracks(config.incomingDir);
    if (!track.length) return { error: "No GPX track uploaded." };

    const resolver = new GeoResolver();
    resolver.addTrack(track);
    const WINDOW_MS = 15 * 60 * 1000;

    const pending = await loadPending();
    const norm = (name: string) => path.basename(name).toLowerCase();
    const byName = new Map(pending.filter((p) => p.originalFilename).map((p) => [norm(p.originalFilename!), p]));

    const placed: Asset[] = [];
    const placedIds = new Set<string>();
    const results: { filename: string; status: string }[] = [];
    for (const { filename, t } of items) {
      if (typeof filename !== "string" || typeof t !== "number" || !Number.isFinite(t)) {
        results.push({ filename: String(filename), status: "bad entry" });
        continue;
      }
      const item = byName.get(norm(filename));
      if (!item) {
        results.push({ filename, status: "no pending match" });
        continue;
      }
      if (placedIds.has(item.id)) {
        results.push({ filename, status: "duplicate" });
        continue;
      }
      const near = resolver.nearest(t);
      if (!near || near.gapMs > WINDOW_MS) {
        results.push({ filename, status: "no GPS match (time out of range)" });
        continue;
      }
      placed.push({ ...item, lat: near.point.lat, lng: near.point.lng, geoSource: "gpx" });
      placedIds.add(item.id);
      results.push({ filename, status: "placed" });
    }

    if (placed.length) {
      await saveAndPublish(upsertAssets(await loadManifest(), placed));
      const state = await State.load();
      for (const a of placed) {
        const rec = state.get(a.id);
        if (rec) state.set({ ...rec, geolocated: true });
      }
      await state.save();
      await savePending(pending.filter((p) => !placedIds.has(p.id)));
    }
    return { placed: placed.length, total: items.length, results };
  }

  // Page through the GoPro Cloud media library for filename + recording time.
  async function fetchGoproMedia(token: string): Promise<{ filename: string; capturedAt: string }[]> {
    const out: { filename: string; capturedAt: string }[] = [];
    for (let page = 1; page <= 500; page++) {
      const url = `https://api.gopro.com/media/search?fields=filename,captured_at,type&per_page=100&page=${page}`;
      const r = await fetch(url, {
        headers: {
          authorization: `Bearer ${token}`,
          accept: "application/vnd.gopro.jk.media+json; version=2.0.0",
        },
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const j = (await r.json()) as {
        _embedded?: { media?: { filename?: string; captured_at?: string }[] };
        _pages?: { current_page: number; total_pages: number };
      };
      for (const m of j._embedded?.media ?? []) {
        if (m.filename && m.captured_at) out.push({ filename: m.filename, capturedAt: m.captured_at });
      }
      if (!j._pages || j._pages.current_page >= j._pages.total_pages) break;
    }
    return out;
  }

  app.post("/api/place", async (req, res) => {
    const { id, lat, lng } = req.body as { id: string; lat: number; lng: number };
    if (typeof lat !== "number" || typeof lng !== "number" || Math.abs(lat) > 90 || Math.abs(lng) > 180) {
      return res.status(400).json({ error: "invalid coordinates" });
    }
    const ok = await commitPlacement(id, lat, lng, "manual");
    res.status(ok ? 200 : 404).json(ok ? { ok: true } : { error: "not found" });
  });

  // Place a pending item by recording time: find where the GPX track was at
  // that instant and pin it there.
  app.post("/api/place-by-time", async (req, res) => {
    const { id, t } = req.body as { id: string; t: number };
    if (typeof t !== "number" || !Number.isFinite(t)) {
      return res.status(400).json({ error: "invalid time" });
    }
    const track = await loadGpxTracks(config.incomingDir);
    if (!track.length) return res.status(400).json({ error: "No GPX track uploaded." });

    const resolver = new GeoResolver();
    resolver.addTrack(track);
    const near = resolver.nearest(t);
    const WINDOW_MS = 15 * 60 * 1000;
    if (!near || near.gapMs > WINDOW_MS) {
      const r = resolver.range();
      const fmt = (x?: number) => (x ? new Date(x).toISOString().replace(".000Z", "Z") : "?");
      return res.status(404).json({
        error: `No GPX point near that time. Track covers ${fmt(r?.start)} – ${fmt(r?.end)} (UTC). Check the date/timezone.`,
      });
    }
    const ok = await commitPlacement(id, near.point.lat, near.point.lng, "gpx");
    res.status(ok ? 200 : 404).json(ok ? { ok: true } : { error: "not found" });
  });

  // Bulk-place pending items from a filename→time mapping (times are epoch ms,
  // converted by the browser in its timezone).
  app.post("/api/place-bulk", async (req, res) => {
    const items = (req.body as { items?: { filename: string; t: number }[] }).items ?? [];
    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ error: "no items" });
    }
    const r = await bulkPlaceByTime(items);
    res.status("error" in r ? 400 : 200).json("error" in r ? r : { ok: true, ...r });
  });

  // Backfill durationSec on already-ingested videos by probing the hosted
  // web.mp4 (reads only the header, no re-transcode).
  app.post("/api/backfill-durations", async (req, res) => {
    const manifest = await loadManifest();
    const todo = manifest.assets.filter((a) => a.type === "video" && a.durationSec === undefined);
    let updated = 0;
    for (const a of todo) {
      const d = await readVideoDuration(a.fullUrl);
      if (d !== undefined) {
        a.durationSec = d;
        updated++;
      }
    }
    if (updated) await saveAndPublish({ ...manifest, assets: manifest.assets });
    res.json({ ok: true, videos: todo.length, updated });
  });

  // Place every pending item that has a capture time onto the GPX track by
  // time-match, in a single manifest publish.
  app.post("/api/place-pending-by-time", async (req, res) => {
    const offMs = (Number((req.body as { timeOffsetMinutes?: number }).timeOffsetMinutes) || 0) * 60_000;
    const track = await loadGpxTracks(config.incomingDir);
    if (!track.length) return res.status(400).json({ error: "No GPX track uploaded." });
    const resolver = new GeoResolver();
    resolver.addTrack(track);
    // Gate on the track's overall span (so off-trip dates stay pending), but
    // snap to the nearest point in time — this places items taken in a gap
    // between track segments (e.g. an overnight at camp) at where the GPS
    // picks back up, rather than dropping them.
    const span = resolver.range()!;

    const pending = await loadPending();
    const placed: Asset[] = [];
    const placedIds = new Set<string>();
    let noTime = 0;
    let noMatch = 0;
    for (const it of pending) {
      const raw = it.capturedAt ? Date.parse(it.capturedAt) : NaN;
      if (!Number.isFinite(raw)) {
        noTime++;
        continue;
      }
      const t = raw + offMs;
      if (t < span.start || t > span.end) {
        noMatch++;
        continue;
      }
      const near = resolver.nearest(t)!;
      placed.push({ ...it, lat: near.point.lat, lng: near.point.lng, geoSource: "gpx" });
      placedIds.add(it.id);
    }
    if (placed.length) {
      await saveAndPublish(upsertAssets(await loadManifest(), placed));
      const state = await State.load();
      for (const a of placed) {
        const rec = state.get(a.id);
        if (rec) state.set({ ...rec, geolocated: true });
      }
      await state.save();
      await savePending(pending.filter((p) => !placedIds.has(p.id)));
    }
    res.json({ ok: true, placed: placed.length, total: pending.length, noTime, noMatch });
  });

  // Import recording times straight from GoPro Cloud and place by filename.
  app.post("/api/gopro-import", async (req, res) => {
    const token = (req.body as { token?: string }).token?.trim().replace(/^Bearer\s+/i, "");
    if (!token) return res.status(400).json({ error: "no token" });
    let media: { filename: string; capturedAt: string }[];
    try {
      media = await fetchGoproMedia(token);
    } catch (err) {
      return res.status(502).json({ error: `GoPro fetch failed: ${(err as Error).message}` });
    }
    const items = media
      .map((m) => ({ filename: m.filename, t: Date.parse(m.capturedAt) }))
      .filter((x) => Number.isFinite(x.t));
    const r = await bulkPlaceByTime(items);
    res.status("error" in r ? 400 : 200).json("error" in r ? r : { ok: true, fetched: media.length, ...r });
  });

  app.post("/api/move", async (req, res) => {
    const { id, lat, lng } = req.body as { id: string; lat: number; lng: number };
    if (typeof lat !== "number" || typeof lng !== "number" || Math.abs(lat) > 90 || Math.abs(lng) > 180) {
      return res.status(400).json({ error: "invalid coordinates" });
    }
    const manifest = await loadManifest();
    const existing = manifest.assets.find((a) => a.id === id);
    if (!existing) return res.status(404).json({ error: "not found" });

    const asset: Asset = { ...existing, lat, lng, geoSource: "manual" };
    await saveAndPublish(upsertAssets(manifest, [asset]));
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
