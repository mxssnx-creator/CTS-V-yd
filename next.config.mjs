// Migration 027 — force full restart: getOpenOrders 25s timeout + dev cycle deadline 180s

const localServerActionAllowedOrigins = ["localhost:3002", "127.0.0.1:3002"]

function normalizeAllowedOrigin(value) {
  const trimmed = value?.trim()
  if (!trimmed) return []

  try {
    return [new URL(trimmed).host]
  } catch {
    return [trimmed.replace(/^https?:\/\//, "").replace(/\/.*$/, "")]
  }
}

function getServerActionAllowedOrigins() {
  const configuredOrigins = [
    process.env.NEXT_PUBLIC_APP_URL,
    process.env.VERCEL_PROJECT_PRODUCTION_URL,
    process.env.SERVER_ACTION_ALLOWED_ORIGINS,
  ]
    .flatMap((value) => value?.split(",") ?? [])
    .flatMap(normalizeAllowedOrigin)
    .filter(Boolean)

  const origins =
    process.env.NODE_ENV === "production"
      ? configuredOrigins
      : [...configuredOrigins, ...localServerActionAllowedOrigins]

  return [...new Set(origins)]
}
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
  serverExternalPackages: [
    "redis",
    "@redis/client",
    // bingx-api ships a NestJS module tree (@nestjs/common) whose optional
    // deps (class-validator/class-transformer) break webpack bundling.
    // Keep it external so Node resolves it at runtime instead.
    "bingx-api",
    "@nestjs/common",
    "class-validator",
    "class-transformer",
  ],
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
      allowedOrigins: getServerActionAllowedOrigins(),
    },
    // instrumentation.ts is auto-discovered by Next.js and remains the
    // deterministic server-side boot sequence entry point.
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
      config.resolve.alias = {
        ...(config.resolve.alias || {}),
        diagnostics_channel: false,
        "node:diagnostics_channel": false,
        net: false,
        "node:net": false,
        tls: false,
        "node:tls": false,
        dns: false,
        "dns/promises": false,
        "node:dns": false,
        "node:dns/promises": false,
        assert: false,
        "node:assert": false,
        perf_hooks: false,
        "node:perf_hooks": false,
        events: false,
        "node:events": false,
        "@node-rs/xxhash": false,
      }
      config.resolve.fallback = {
        ...(config.resolve.fallback || {}),
        crypto: false,
        stream: false,
        buffer: false,
        diagnostics_channel: false,
        "@node-rs/xxhash": false,
      }
    }

    // Edge runtime: stub every Node built-in that server-side libs import.
    // IMPORTANT: do not apply these aliases to the normal Node server bundle.
    // Production webpack compilation is the only mode that bundles route code;
    // aliasing `net`/`tls`/`dns`/`events` to `false` there makes Redis,
    // exchange SDKs, and Node HTTP clients resolve to empty modules. Dev mode
    // does not hit that bundled path, which is why production alone saw
    // stalls/crashes. Keep the stubs scoped to browser/edge only.
    if (nextRuntime === "edge") {
      const nodeBuiltinsToStub = [
        "diagnostics_channel",
        "net",
        "tls",
        "dns",
        "dns/promises",
        "assert",
        "perf_hooks",
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
