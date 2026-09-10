import type { NextConfig } from "next";

const configuredApiOrigin = process.env.PRODUCT_METRICS_API_URL;

const nextConfig: NextConfig = {
  agentRules: false,
  async rewrites() {
    if (!configuredApiOrigin) return [];
    const apiOrigin = configuredApiOrigin.replace(/\/+$/, "");
    return [
      { source: "/health", destination: `${apiOrigin}/health` },
      { source: "/api/:path*", destination: `${apiOrigin}/api/:path*` },
    ];
  },
};

export default nextConfig;
