import type { NextConfig } from "next";

// `@bounty/core` is transpiled, which pulls its `better-sqlite3` import (and that
// package's native loader, `bindings`) into the webpack server bundle. Once
// bundled, `bindings` can't resolve its `.node` binary — `bindings.getFileName`
// reads an undefined stack frame and every server query 500s. `serverExternalPackages`
// alone doesn't cover the transitive `bindings`, so force both to runtime
// `commonjs` externals on the server build.
const NATIVE_EXTERNALS = ["better-sqlite3", "bindings"];

const nextConfig: NextConfig = {
  transpilePackages: [
    "@bounty/core",
    "@bounty/security-analyzer",
    "@bounty/security-solver",
    "@bounty/security-discovery",
  ],
  serverExternalPackages: [...NATIVE_EXTERNALS, "pino", "pino-pretty"],
  webpack: (config, { isServer }) => {
    if (isServer) {
      config.externals = [
        ...(Array.isArray(config.externals)
          ? config.externals
          : [config.externals].filter(Boolean)),
        ({ request }: { request?: string }, cb: (err?: unknown, result?: string) => void) =>
          request && NATIVE_EXTERNALS.includes(request)
            ? cb(undefined, `commonjs ${request}`)
            : cb(),
      ];
    }
    return config;
  },
};

export default nextConfig;
