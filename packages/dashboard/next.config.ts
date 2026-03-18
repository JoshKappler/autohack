import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  transpilePackages: ["@algora/core"],
  serverExternalPackages: ["better-sqlite3", "pino", "pino-pretty"],
};

export default nextConfig;
