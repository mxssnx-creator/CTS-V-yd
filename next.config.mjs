// Migration 025 deadlock fix applied — forces full server restart
/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: false,
  typescript: {
    // Production deployments must fail on type or syntax drift instead of
    // shipping a partially-compiled bundle.
    ignoreBuildErrors: false,
  },
  eslint: {
    // Keep lint validation enabled during builds so deployment catches the
    // same issues local checks catch before runtime.
    ignoreDuringBuilds: false,
  },
  images: {
    unoptimized: true,
  },
  // ── Tier-3 perf: prod-only console removal ───────────────────────
  // Strips `console.log` / `console.debug` / `console.info` from
  // production client + server bundles, keeping `console.error` and
  // `console.warn` for crash diagnostics. Dev mode is untouched, so
  // local debugging still sees `[v0]` traces, hot-reload logs, etc.
  // The volume of strategy/coordination logs in this codebase is
  // substantial — each call is a serialisation + I/O cost on the
  // hot path that we don't want shipping to production users.
  compiler: {
    removeConsole:
      process.env.NODE_ENV === "production"
        ? { exclude: ["error", "warn"] }
        : false,
  },
  experimental: {
    serverActions: {
      allowedOrigins: ["*"],
    },
    // Enable instrumentation hook for deterministic server-side boot sequence
    // (migrations, global state initialization, orphan cleanup) on every
    // process start. Critical for production stability.
    instrumentationHook: true,
  },
  // Production-specific headers for performance
  async headers() {
    return process.env.NODE_ENV === "production" ? [
      {
        source: "/api/:path*",
        headers: [
          { key: "Cache-Control", value: "no-cache, no-store, must-revalidate" },
          { key: "Pragma", value: "no-cache" },
          { key: "Expires", value: "0" },
        ],
      },
      {
        source: "/_next/static/:path*",
        headers: [
          { key: "Cache-Control", value: "public, max-age=31536000, immutable" },
        ],
      },
    ] : []
  },
  // Production-specific redirects for health checks and monitoring
  async redirects() {
    return process.env.NODE_ENV === "production" ? [
      {
        source: "/health",
        destination: "/api/system/status",
        permanent: false,
      },
    ] : []
  },
  webpack: (config, { isServer, nextRuntime, webpack }) => {
    config.resolve = config.resolve || {}
    config.plugins = config.plugins || []

    // Strip the `node:` URI scheme so Webpack 5 can resolve Node built-ins
    // on both server and edge targets without UnhandledSchemeError.
    config.plugins.push(
      new webpack.NormalModuleReplacementPlugin(/^node:/, (resource) => {
        resource.request = resource.request.replace(/^node:/, "")
      }),
    )

    // Browser bundle: alias Node built-ins to empty stubs.
    if (!isServer) {
      config.resolve.fallback = {
        ...(config.resolve.fallback || {}),
        crypto: false,
        stream: false,
        buffer: false,
      }
    }

    // Edge runtime: stub every Node built-in that server-side libs import.
    // The instrumentation.ts runtime guard ensures stubs are never executed.
    if (nextRuntime === "edge") {
      const nodeBuiltinsToStub = [
        "crypto",
        "fs",
        "fs/promises",
        "path",
        "stream",
        "buffer",
        "events",
        "timers",
        "timers/promises",
        "os",
        "url",
        "util",
        "zlib",
      ]
      const stubAliases = {}
      for (const name of nodeBuiltinsToStub) {
        stubAliases[name] = false
        stubAliases[`node:${name}`] = false
      }
      config.resolve.alias = {
        ...(config.resolve.alias || {}),
        ...stubAliases,
      }
    }

    return config
  },
}

export default nextConfig
