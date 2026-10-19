import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  // Secrets are never exposed to the browser bundle: only DATABASE_URL etc. are
  // read server-side, and nothing is prefixed NEXT_PUBLIC_ except the widget origin.
  env: {},
};

export default nextConfig;
