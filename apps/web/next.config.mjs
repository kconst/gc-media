/** @type {import('next').NextConfig} */

// The manifest lives on CloudFront (a different origin). Proxy it through the
// app so the browser fetches it same-origin and CORS never applies.
const MANIFEST_TARGET =
  process.env.MANIFEST_PROXY_TARGET ||
  "https://d3etcbrcz4shm0.cloudfront.net/manifest.json";

const nextConfig = {
  reactStrictMode: true,
  // @gc-media/shared ships TS source; let Next transpile it.
  transpilePackages: ["@gc-media/shared"],
  async rewrites() {
    return [{ source: "/manifest.json", destination: MANIFEST_TARGET }];
  },
  webpack: (config) => {
    // Resolve NodeNext-style ".js" relative imports to their ".ts" sources.
    config.resolve.extensionAlias = {
      ".js": [".ts", ".tsx", ".js", ".jsx"],
      ...(config.resolve.extensionAlias ?? {}),
    };
    return config;
  },
};

export default nextConfig;
