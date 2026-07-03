import { getSettings, getAllConnections, initRedis, saveMarketData, setAppSettings, updateConnection } from "@/lib/redis-db"
import { runMigrations } from "@/lib/redis-migrations"

let ran = false

function shouldRunPreStartup(): boolean {
  if (process.env.NEXT_RUNTIME !== "nodejs") return false
  // In production, we still need to run essential initialization (Redis, migrations)
  // but we skip the UI/UX seeding and connection testing
  return true
}

async function initializeDefaultSettings() {
  // Check canonical first; if empty, check legacy before giving up so we
  // don't stomp a migration-in-progress state where only `all_settings`
  // has been seeded.
  const canonical = await getSettings("app_settings")
  if (canonical && Object.keys(canonical).length > 0) return
  const legacy = await getSettings("all_settings")
  const { getDefaultSettings } = await import("@/lib/settings-storage")
  // `setAppSettings` mirrors the defaults to BOTH the canonical
  // (`app_settings`) and legacy (`all_settings`) keys in one go, so
  // trade-engine consumers reading `all_settings` boot with populated
  // values without waiting for the operator to hit Save.
  const seed = legacy && Object.keys(legacy).length > 0 ? legacy : getDefaultSettings()
  await setAppSettings(seed)
}

async function seedPredefinedConnections() {
  // Base connections are seeded by redis-db and migrations.
  // In dev environments, configure trading symbols for enabled connections
  if (process.env.NODE_ENV !== "production") {
    try {
      const allConnections = await getAllConnections()
      const { getRedisClient } = await import("@/lib/redis-db")
      const client = getRedisClient()
      
      // Configuration: 8 high-liquidity trading symbols for BingX
      const devSymbols = ["BTCUSDT", "ETHUSDT", "TAIKO", "VELVET", "BEAT", "ZROU", "WLD", "JTO"]
      
      for (const conn of allConnections) {
        if (conn.exchange === "bingx") {
          // Write symbols to BOTH locations:
          // 1. Main connection:{id} hash (where getConnection() reads symbol_count from)
          await client.hset(`connection:${conn.id}`, {
            symbol_count: String(devSymbols.length),
            symbols: devSymbols.join(","),
            force_symbols: JSON.stringify(devSymbols),
          })
          
          // 2. trade_engine_state:{id} hash (where getSymbols() reads force_symbols from)
          await client.hset(`trade_engine_state:${conn.id}`, {
            symbols: JSON.stringify(devSymbols),
            force_symbols: JSON.stringify(devSymbols),
            symbol_count: String(devSymbols.length),
          })
          
          console.log(`[v0] [PreStartup] Configured ${devSymbols.length} trading symbols for ${conn.id}`)
        }
      }
    } catch (e) {
      console.warn(`[v0] [PreStartup] Warning during symbol seeding (non-fatal): ${e instanceof Error ? e.message : e}`)
    }
  }
}

async function seedMarketData() {
  // Only seed placeholder prices when the canonical key for BTCUSDT does not
  // already exist. This prevents overwriting real market data that was fetched
  // by the live-price loader on a previous run (e.g. after a hot-reload in dev
  // or after a cold start where the Redis snapshot was already restored from disk).
  try {
    const { getRedisClient } = await import("@/lib/redis-db")
    const client = getRedisClient()
    const existing = await client.exists("market_data:BTCUSDT")
    if (existing) {
      console.log("[v0] [PreStartup] seedMarketData: real data present — skipping placeholder seed")
      return
    }
  } catch {
    // If the Redis check fails, fall through and seed anyway so the engine has
    // something to work with on a completely fresh DB.
  }

  const symbols = ["BTCUSDT", "ETHUSDT", "BNBUSDT", "XRPUSDT", "ADAUSDT", "SOLUSDT"]
  const basePrices: Record<string, number> = {
    BTCUSDT: 100000,
    ETHUSDT: 3500,
    BNBUSDT: 700,
    XRPUSDT: 0.6,
    ADAUSDT: 0.8,
    SOLUSDT: 180,
  }

  // ── Parallel seeding ────────────────────────────────────────────
  // Every (symbol, tick) write is independent. Previously this was a
  // nested for-loop with 6 × 20 = 120 sequential awaits — easily a
  // full second of pointless serialisation on every startup. Fan
  // out everything in a single Promise.all so the placeholder seed
  // lands on Redis as one parallel batch.
  await Promise.all(
    symbols.flatMap((symbol) => {
      const base = basePrices[symbol] ?? 100
      return Array.from({ length: 20 }, (_v, i) => {
        const variation = base * 0.02
        const close = base + (Math.random() - 0.5) * variation
        // Spec §7: pre-startup seeds 1s placeholders so the engine has
        // *something* under the canonical key before the real loader
        // runs. Timestamps step at 1s instead of 60s.
        return saveMarketData(symbol, "1s", {
          symbol,
          exchange: "bybit",
          interval: "1s",
          price: close,
          open: base,
          high: base + variation,
          low: base - variation,
          close,
          volume: Math.random() * 1_000_000,
          timestamp: new Date(Date.now() - (20 - i) * 1_000).toISOString(),
        })
      })
    }),
  )
  console.log("[v0] [PreStartup] seedMarketData: seeded placeholder prices for", symbols.length, "symbols")
}

export async function testAllExchangeConnections() {
  try {
    const allConnections = await getAllConnections()
    const testable = allConnections.filter((c: any) => {
      const inserted = c.is_active_inserted === true || c.is_active_inserted === "true" || c.is_active_inserted === "1"
      const keyOk = typeof c.api_key === "string" && c.api_key.length >= 20 && !c.api_key.includes("PLACEHOLDER")
      const secretOk = typeof c.api_secret === "string" && c.api_secret.length >= 10 && !c.api_secret.includes("PLACEHOLDER")
      return inserted && keyOk && secretOk
    })

    if (testable.length === 0) {
      return { tested: 0, passed: 0, failed: 0 }
    }

    const now = new Date().toISOString()
    for (const connection of testable) {
      await updateConnection(connection.id, {
        ...connection,
        last_test_status: "skipped",
        last_test_time: now,
        last_test_message: "Startup connector tests disabled in safe bootstrap mode",
      })
    }

    return { tested: testable.length, passed: 0, failed: 0 }
  } catch {
    return { tested: 0, passed: 0, failed: 0 }
  }
}

export function startPeriodicConnectionTesting() {
  // Disabled in safe bootstrap mode.
}

export async function runPreStartup() {
  if (!shouldRunPreStartup()) return
  if (ran) return
  ran = true

  try {
    await initRedis()
    await runMigrations()

    // Settings seeding and market data placeholder seeding must run in ALL modes.
    // On a production cold-start with empty Redis the engine would boot with no
    // settings and no market data at all — both are no-ops when data already exists.
    await initializeDefaultSettings()
    await seedPredefinedConnections()
    await seedMarketData()

    // Connection testing is skipped in safe bootstrap mode (both dev and prod).
    // The engine tests connections lazily when it first ticks.

    // Engine start is intentionally skipped in safe bootstrap mode.
  } catch (error) {
    console.error("[v0] Pre-startup failed:", error)
  }
}
