import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  transpilePackages: [
    "@bounty/core",
    "@bounty/security-analyzer",
    "@bounty/security-solver",
    "@bounty/security-discovery",
  ],
  serverExternalPackages: ["better-sqlite3", "pino", "pino-pretty"],
};

export default nextConfig;
