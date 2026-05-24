import type { NextConfig } from "next";

const config: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  // Type-checking + lint run separately in CI / dev. Don't block deploys on them.
  typescript: { ignoreBuildErrors: true },
  eslint: { ignoreDuringBuilds: true },
  // Keep Node-only packages out of the webpack bundle (they fail to compile
  // for the Edge runtime and bloat the server bundle).
  serverExternalPackages: [
    "applicationinsights",
    "@azure/monitor-opentelemetry",
    "@azure/monitor-opentelemetry-exporter",
    "@azure/functions-core",
    "@azure/storage-blob",
    "@prisma/client",
    "prisma",
    "@microsoft/microsoft-graph-client",
  ],
  experimental: {
    serverActions: { bodySizeLimit: "10mb" },
  },
  images: {
    remotePatterns: [
      { protocol: "https", hostname: "bluecollarcoach.us" },
      { protocol: "https", hostname: "*.blob.core.windows.net" },
    ],
  },
  async headers() {
    return [
      {
        source: "/(.*)",
        headers: [
          { key: "X-Frame-Options", value: "DENY" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          {
            key: "Permissions-Policy",
            value: "camera=(), microphone=(), geolocation=(self)",
          },
        ],
      },
    ];
  },
};

export default config;
