/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // @gc-media/shared ships TS source; let Next transpile it.
  transpilePackages: ["@gc-media/shared"],
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
