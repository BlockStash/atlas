import type { NextConfig } from "next";
import path from "node:path";
const config: NextConfig = {
  // Hides the floating Next.js "N" dev badge.
  devIndicators: false,
  turbopack: { root: path.resolve(process.cwd()) },
  async rewrites() {
    return [
      {
        source: "/api/:path*",
        destination: `${process.env.BACKEND_URL || "http://127.0.0.1:4000"}/api/:path*`,
      },
    ];
  },
};
export default config;
