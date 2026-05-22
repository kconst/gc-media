import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { google } from "googleapis";
import type { AssetType } from "@gc-media/shared";
import { config } from "../config.js";
import type { IngestItem } from "../types.js";
import { hashFile } from "../util/hash.js";

const SCOPES = ["https://www.googleapis.com/auth/photoslibrary.readonly"];
const REDIRECT_PORT = 53682;
const REDIRECT_URI = `http://localhost:${REDIRECT_PORT}/oauth2callback`;

/**
 * NOTE: the Google Photos API does not expose GPS, and (post-2025) typically
 * only returns app-created or Picker-selected media. This adapter handles
 * RETRIEVAL only — coordinates come from the geolocation resolver (EXIF in the
 * downloaded original, GoPro time-match, or manual placement).
 */
async function getAuthClient() {
  const oauth2 = new google.auth.OAuth2(
    config.google.clientId(),
    config.google.clientSecret(),
    REDIRECT_URI,
  );

  try {
    const token = JSON.parse(await fs.readFile(config.google.tokenPath, "utf8"));
    oauth2.setCredentials(token);
    return oauth2;
  } catch {
    // Need an interactive login.
  }

  const authUrl = oauth2.generateAuthUrl({
    access_type: "offline",
    prompt: "consent",
    scope: SCOPES,
  });

  const code = await new Promise<string>((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const url = new URL(req.url ?? "", REDIRECT_URI);
      const c = url.searchParams.get("code");
      if (c) {
        res.end("Authorized. You can close this tab and return to the terminal.");
        server.close();
        resolve(c);
      } else {
        res.statusCode = 400;
        res.end("Missing code");
      }
    });
    server.listen(REDIRECT_PORT);
    server.on("error", reject);
    console.log(`\nOpen this URL to authorize Google Photos access:\n${authUrl}\n`);
  });

  const { tokens } = await oauth2.getToken(code);
  oauth2.setCredentials(tokens);
  await fs.mkdir(path.dirname(config.google.tokenPath), { recursive: true });
  await fs.writeFile(config.google.tokenPath, JSON.stringify(tokens, null, 2));
  return oauth2;
}

interface MediaItem {
  id: string;
  filename: string;
  mimeType: string;
  baseUrl: string;
}

function classify(mimeType: string): AssetType | undefined {
  if (mimeType.startsWith("image/")) return "photo";
  if (mimeType.startsWith("video/")) return "video";
  return undefined;
}

/** Fetch accessible media items, download originals into the incoming dir. */
export async function ingestGooglePhotos(limit = 200): Promise<IngestItem[]> {
  const auth = await getAuthClient();
  const { token } = await auth.getAccessToken();
  if (!token) throw new Error("Failed to obtain Google access token");

  await fs.mkdir(config.incomingDir, { recursive: true });
  const items: IngestItem[] = [];
  let pageToken: string | undefined;

  while (items.length < limit) {
    const url = new URL("https://photoslibrary.googleapis.com/v1/mediaItems");
    url.searchParams.set("pageSize", "50");
    if (pageToken) url.searchParams.set("pageToken", pageToken);
    const resp = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    if (!resp.ok) throw new Error(`Google Photos list failed: ${resp.status} ${await resp.text()}`);
    const body = (await resp.json()) as { mediaItems?: MediaItem[]; nextPageToken?: string };

    for (const m of body.mediaItems ?? []) {
      const type = classify(m.mimeType);
      if (!type) continue;
      // "=d" requests the original bytes (preserving EXIF where available).
      const dl = `${m.baseUrl}=d`;
      const fileResp = await fetch(dl, { headers: { Authorization: `Bearer ${token}` } });
      if (!fileResp.ok) continue;
      const dest = path.join(config.incomingDir, m.filename);
      await fs.writeFile(dest, Buffer.from(await fileResp.arrayBuffer()));
      const id = await hashFile(dest);
      items.push({
        id,
        localPath: dest,
        originalFilename: m.filename,
        type,
        source: "google-photos",
      });
      if (items.length >= limit) break;
    }

    pageToken = body.nextPageToken;
    if (!pageToken) break;
  }

  return items;
}
