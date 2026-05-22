# Grand Canyon Trip Map

An interactive Google Map of our Grand Canyon trip (South Rim → Bright Angel and
South Kaibab trails). Photos and GoPro videos become thumbnail **pins** placed by
GPS coordinates. Click a pin for the media, an AI-written description, and
filterable labels (plants, animals, people morale, interesting). A reusable
**loader** ingests new media over time so the map keeps growing.

## Layout

```
apps/web/        Next.js app (deploy to Vercel) — the interactive map
packages/loader/ Node/TS CLI — ingest, geolocate, analyze, upload, publish
packages/shared/ Shared TS types (the manifest is the source of truth)
infra/           Terraform — S3 + CloudFront (OAC) + scoped loader IAM
data/            Local working dir (manifest, state, caches) — gitignored
```

## Prerequisites

- Node 20+.
- **ffmpeg** on PATH (video posters/renditions/frame sampling).
- **Terraform** CLI (one-time infra provisioning).
- Accounts/keys: Anthropic API key, Google OAuth client (Photos), Google Maps
  JS API key + Map ID, AWS (temporary admin creds for provisioning), Vercel.

Copy `.env.example` → `.env` and fill it in as you go.

## 1. Provision AWS infrastructure (Terraform)

Export your **temporary** AWS admin credentials, then:

```bash
cd infra
export AWS_ACCESS_KEY_ID=... AWS_SECRET_ACCESS_KEY=... AWS_SESSION_TOKEN=...
terraform init
terraform apply -var 'web_origins=["http://localhost:3000","https://YOUR.vercel.app"]'
```

This creates a private S3 bucket, a CloudFront distribution (Origin Access
Control — only CloudFront can read the bucket), and a **least-privilege IAM
user** for the loader. Copy the outputs into `.env`:

```bash
terraform output -raw media_bucket                 # → MEDIA_BUCKET
terraform output -raw cloudfront_domain            # → CLOUDFRONT_DOMAIN
terraform output -raw loader_aws_access_key_id     # → LOADER_AWS_ACCESS_KEY_ID
terraform output -raw loader_aws_secret_access_key # → LOADER_AWS_SECRET_ACCESS_KEY
```

The loader uploads with these scoped keys — never your expiring admin creds.

## 2. Run the loader

```bash
npm install

# Ingest a folder (GoPro SD originals, Quik exports, or unzipped Takeout):
npm run loader -- run --source local --dir /path/to/media --credit "Alex"

# Or pull from Google Photos (opens an OAuth login in your browser):
npm run loader -- run --source google
```

Pipeline per asset: extract EXIF/GoPro-GPMF metadata → resolve coordinates
(EXIF GPS → time-match against the GoPro GPS track → otherwise pending) →
generate derivatives (sharp/ffmpeg) → upload to S3 → analyze with Claude vision
→ upsert into `manifest.json` and publish it.

> **Geolocation note:** the Google Photos API does not return GPS, so coordinates
> come from EXIF in the original file, time-matching against GoPro telemetry, or
> the manual placement UI below.

### Place leftover assets by hand

```bash
npm run loader -- place      # opens http://localhost:4321
```

Drag each thumbnail onto the map to set its pin; it's added to the manifest
with `geoSource: "manual"`.

## 3. Run / deploy the web app

```bash
cp apps/web/.env.local.example apps/web/.env.local   # uses the bundled sample manifest
npm run web:dev                                       # http://localhost:3000
```

Deploy to **Vercel** with the project root set to `apps/web` (it's a workspace,
so set the root directory and Vercel will install from the monorepo). Set env
vars in Vercel: `NEXT_PUBLIC_GOOGLE_MAPS_API_KEY`, `NEXT_PUBLIC_GOOGLE_MAPS_MAP_ID`,
and `NEXT_PUBLIC_MANIFEST_URL` (the CloudFront URL of `manifest.json`).

## Adding more photos later

Just re-run the loader (`run` is incremental — it skips assets already in
`data/state.json`). The manifest is re-published to S3/CloudFront and the live
site picks up new pins on next load — **no redeploy needed**.
