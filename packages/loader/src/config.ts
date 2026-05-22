import "dotenv/config";
import path from "node:path";

/** Resolve repo-root-relative paths so the loader works from any cwd. */
const DATA_DIR = process.env.GC_DATA_DIR
  ? path.resolve(process.env.GC_DATA_DIR)
  : path.resolve(process.cwd(), "data");

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
}

export const config = {
  dataDir: DATA_DIR,
  cacheDir: path.join(DATA_DIR, "cache"),
  incomingDir: path.join(DATA_DIR, "incoming"),
  derivativesDir: path.join(DATA_DIR, "derivatives"),
  statePath: path.join(DATA_DIR, "state.json"),
  manifestPath: path.join(DATA_DIR, "manifest.json"),

  anthropicApiKey: () => required("ANTHROPIC_API_KEY"),

  aws: {
    region: process.env.AWS_REGION ?? "us-west-2",
    bucket: () => required("MEDIA_BUCKET"),
    cloudfrontDomain: () => required("CLOUDFRONT_DOMAIN"),
    // Loader uses the SCOPED keys, falling back to ambient creds if unset.
    accessKeyId: process.env.LOADER_AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.LOADER_AWS_SECRET_ACCESS_KEY,
  },

  google: {
    clientId: () => required("GOOGLE_OAUTH_CLIENT_ID"),
    clientSecret: () => required("GOOGLE_OAUTH_CLIENT_SECRET"),
    tokenPath:
      process.env.GOOGLE_OAUTH_TOKEN_PATH ??
      path.join(DATA_DIR, "google-token.json"),
  },

  manifest: {
    store: (process.env.MANIFEST_STORE ?? "s3") as "s3" | "local",
    key: process.env.MANIFEST_KEY ?? "manifest.json",
  },
};

export type Config = typeof config;
