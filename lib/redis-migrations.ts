/**
 * Redis Migration Runner - Complete System
 * Handles schema initialization and data migrations for all system components
 */

import { getRedisClient, ensureCoreRedis, setMigrationsRun, haveMigrationsRun } from "./redis-db"

/**
 * Reset the in-process migration guards.
 *
 * MUST be called by any code path that wipes the Redis keyspace
 * (FLUSHALL / flushDb), e.g. the Reset-DB and Flush-DB install routes.
 *
 * Why this is required:
 *   `runMigrations()` short-circuits on two process-level guards —
 *   the cached `migrationRunPromise` (returns the FIRST run's resolved
 *   promise to every later caller) and `haveMigrationsRun()`. A DB wipe
 *   deletes `_schema_version` / `_migrations_run` from Redis but cannot
 *   touch these JS-module guards. Without resetting them, the
 *   post-flush `runMigrations()` call returns the stale resolved promise
 *   and the migrations (001–022) NEVER replay, leaving the database
 *   half-initialised (no schema version, no metadata hashes, no seeded
 *   indexes). Calling this before re-running migrations forces a full,
 *   clean replay against the now-empty keyspace.
 */
/**
 * Cross-module-scope coalescing guard.
 *
 * In Next.js dev each route bundle can load its own copy of this module, so a
 * plain module-level `let migrationRunPromise` is NOT shared between routes.
 * During a startup burst dozens of routes each saw their own `null` promise
 * and launched a FULL v0→v22 migration concurrently (observed: 54 parallel
 * runs), starving the event loop and tripping realtime-cycle deadlines.
 *
 * Hoisting the in-flight promise onto globalThis makes every module scope
 * coalesce onto a single execution — the true single-flight the comment in
 * runMigrations() always intended.
 */
const globalMigrationGuard = globalThis as unknown as {
  __migration_run_promise?: Promise<{ success: boolean; message: string; version: number }> | null
  __coverage_repair_done?: boolean
}

function getMigrationRunPromise() {
  return globalMigrationGuard.__migration_run_promise ?? null
}
function setMigrationRunPromise(
  p: Promise<{ success: boolean; message: string; version: number }> | null,
) {
  globalMigrationGuard.__migration_run_promise = p
}

export function resetMigrationRunState(): void {
  setMigrationRunPromise(null)
  // Clear the one-shot diagnostic set so post-reset boot logs are emitted
  // again (e.g. "already at latest", operator_stopped honoured).
  ensureBootstrapDiag.clear()
  // Allow coverage repair to run again after a DB flush so fresh connections
  // get their metadata scaffolding.
  globalMigrationGuard.__coverage_repair_done = false
  try {
    setMigrationsRun(false)
  } catch {
    // setMigrationsRun is a pure setter; failure here is non-fatal.
  }
}
import { getBaseConnectionCredentials, type BaseConnectionId } from "./base-connection-credentials"

interface Migration {
  name?: string
  description?: string
  version: number
  up: (client: any) => Promise<void>
  down: (client: any) => Promise<void>
}

// NOTE: the in-flight coalescing promise now lives on globalThis (see
// globalMigrationGuard above) so it is shared across all dev module scopes.

const migrations: Migration[] = [
  {
    name: "001-initial-schema",
    version: 1,
    up: async (client: any) => {
      await client.set("_schema_version", "1")
      // Initialize set keys without empty strings - sets are created empty on first use
      const keys = [
        "connections:all", "connections:bybit", "connections:bingx", "connections:pionex", "connections:orangex",
        "connections:active", "connections:inactive",
        "trades:all", "trades:open", "trades:closed", "trades:pending",
        "positions:all", "positions:open", "positions:closed",
        "users:all", "sessions:all", "presets:all", "preset_types:all",
        "strategies:all", "strategies:active",
        "monitoring:events", "logs:system", "logs:trades", "logs:errors"
      ]
      // Initialize each set as empty (don't add empty strings)
      for (const key of keys) {
        // Just create the key structure by setting a marker
        await client.set(`_index:${key}`, "initialized")
      }
      console.log("[v0] Migration 001: Initial schema created")
    },
    down: async (client: any) => {
      await client.del("_schema_version")
    },
  },
  {
    name: "002-connection-management",
    version: 2,
    up: async (client: any) => {
      await client.set("_schema_version", "2")
      await client.set("_connections_indexed", "true")
      await client.hset("connections:metadata", {
        total_configured: "0",
        total_active: "0",
        total_errors: "0",
        last_sync: new Date().toISOString(),
      })
      for (const exchange of ["bybit", "bingx", "pionex", "orangex"]) {
        await client.hset(`exchange:${exchange}:metadata`, {
          name: exchange,
          api_calls_used: "0",
          api_rate_limit: "0",
          last_updated: new Date().toISOString(),
        })
      }
      console.log("[v0] Migration 002: Connection management structure created")
    },
    down: async (client: any) => {
      await client.del("_connections_indexed")
      await client.set("_schema_version", "1")
    },
  },
  {
    name: "003-trade-positions-schema",
    version: 3,
    up: async (client: any) => {
      await client.set("_schema_version", "3")
      await client.set("_trades_initialized", "true")
      await client.hset("trades:metadata", {
        total_trades: "0", total_open: "0", total_closed: "0",
        total_win: "0", total_loss: "0", total_profit: "0",
        avg_profit: "0", win_rate: "0", last_trade_time: "",
      })
      await client.hset("positions:metadata", {
        total_positions: "0", total_open_positions: "0", total_closed_positions: "0",
        total_contracts: "0", total_collateral: "0", total_pnl: "0", avg_leverage: "0",
      })
      await client.set("trades:counter:open", "0")
      await client.set("trades:counter:closed", "0")
      await client.set("trades:counter:pending", "0")
      await client.set("positions:counter:open", "0")
      await client.set("positions:counter:closed", "0")
      console.log("[v0] Migration 003: Trade and position schemas created")
    },
    down: async (client: any) => {
      await client.del("_trades_initialized")
      await client.set("_schema_version", "2")
    },
  },
  {
    name: "004-preset-strategy-management",
    version: 4,
    up: async (client: any) => {
      await client.set("_schema_version", "4")
      await client.set("_presets_initialized", "true")
      await client.hset("presets:metadata", {
        total_presets: "0", total_active: "0", total_inactive: "0",
        total_runs: "0", avg_success_rate: "0",
      })
      await client.hset("strategies:metadata", {
        total_strategies: "0", total_active_strategies: "0",
        total_backtests: "0", avg_win_rate: "0", avg_profit_factor: "0",
      })
      // Sets are created lazily on first real insert; avoid empty placeholder members.
      await client.set("strategies:counter:active", "0")
      await client.set("strategies:counter:paused", "0")
      await client.set("strategies:counter:stopped", "0")
      console.log("[v0] Migration 004: Preset and strategy management created")
    },
    down: async (client: any) => {
      await client.del("_presets_initialized")
      await client.set("_schema_version", "3")
    },
  },
  {
    name: "005-user-authentication",
    version: 5,
    up: async (client: any) => {
      await client.set("_schema_version", "5")
      await client.set("_auth_initialized", "true")
      await client.hset("users:metadata", {
        total_users: "1", total_active_sessions: "0",
        last_login: new Date().toISOString(),
      })
      await client.hset("sessions:metadata", {
        total_sessions: "0", active_sessions: "0", expired_sessions: "0",
      })
      const adminId = "admin-001"
      await client.hset(`user:${adminId}`, {
        id: adminId, username: "admin", email: "admin@trading-engine.local",
        role: "admin", created_at: new Date().toISOString(),
        last_login: new Date().toISOString(), status: "active", api_keys_count: "0",
      })
      await client.sadd("users:all", adminId)
      await client.sadd("users:admin", adminId)
      console.log("[v0] Migration 005: User authentication system created")
    },
    down: async (client: any) => {
      await client.del("_auth_initialized")
      await client.set("_schema_version", "4")
    },
  },
  {
    name: "006-monitoring-logging",
    version: 6,
    up: async (client: any) => {
      await client.set("_schema_version", "6")
      await client.set("_monitoring_initialized", "true")
      await client.hset("monitoring:metadata", {
        total_events: "0", critical_events: "0", warning_events: "0",
        info_events: "0", last_event_time: new Date().toISOString(),
      })
      await client.hset("system:health", {
        status: "healthy", uptime_seconds: "0", memory_usage: "0",
        cpu_usage: "0", last_check: new Date().toISOString(),
      })
      await client.hset("system:performance", {
        avg_response_time: "0", trades_per_minute: "0",
        api_calls_per_minute: "0", errors_per_hour: "0",
      })
      await client.set("logs:system:counter", "0")
      await client.set("logs:trades:counter", "0")
      await client.set("logs:errors:counter", "0")
      console.log("[v0] Migration 006: Monitoring and logging system created")
    },
    down: async (client: any) => {
      await client.del("_monitoring_initialized")
      await client.set("_schema_version", "5")
    },
  },
  {
    name: "007-cache-optimization",
    version: 7,
    up: async (client: any) => {
      await client.set("_schema_version", "7")
      await client.set("_cache_optimized", "true")
      await client.hset("cache:config", {
        connection_cache_ttl: "3600", trade_cache_ttl: "1800",
        position_cache_ttl: "900", strategy_cache_ttl: "7200", monitoring_cache_ttl: "300",
      })
      await client.hset("cache:stats", {
        total_hits: "0", total_misses: "0", hit_rate: "0", total_evictions: "0",
      })
      // Sets are created lazily on first real insert; avoid empty placeholder members.
      console.log("[v0] Migration 007: Cache optimization created")
    },
    down: async (client: any) => {
      await client.del("_cache_optimized")
      await client.set("_schema_version", "6")
    },
  },
  {
    name: "008-performance-optimizations",
    version: 8,
    up: async (client: any) => {
      await client.set("_schema_version", "8")
      await client.set("_ttl_policies_set", "true")
      await client.hset("system:config", {
        database_type: "redis", initialized_at: new Date().toISOString(),
        version: "3.2", environment: "production", log_level: "info",
      })
      await client.hset("system:thresholds", {
        max_concurrent_trades: "1000", max_api_calls_per_minute: "6000",
        max_positions_per_connection: "500", max_connections: "100", memory_limit_mb: "1024",
      })
      await client.hset("ratelimit:config", {
        trades_per_second: "100", api_calls_per_second: "200", batch_operations_per_second: "50",
      })
      console.log("[v0] Migration 008: Performance optimizations configured")
    },
    down: async (client: any) => {
      await client.del("_ttl_policies_set")
      await client.set("_schema_version", "7")
    },
  },
  {
    name: "009-backup-recovery",
    version: 9,
    up: async (client: any) => {
      await client.set("_schema_version", "9")
      await client.set("_backup_initialized", "true")
      await client.hset("backup:metadata", {
        last_backup_time: "", last_backup_size: "0", total_backups: "0",
        backup_retention_days: "30", auto_backup_enabled: "true",
      })
      await client.hset("recovery:points", {
        total_recovery_points: "0", last_recovery_time: "", last_recovery_success: "false",
      })
      // Sets are created lazily on first real insert; avoid empty placeholder members.
      console.log("[v0] Migration 009: Backup and recovery system created")
    },
    down: async (client: any) => {
      await client.del("_backup_initialized")
      await client.set("_schema_version", "8")
    },
  },
  {
    name: "010-settings-and-metadata",
    version: 10,
    up: async (client: any) => {
      await client.set("_schema_version", "10")
      await client.hset("settings:system", {
        trade_engine_enabled: "true", auto_migration: "true",
        fallback_mode: "memory", theme: "dark", timezone: "UTC", language: "en",
      })
      await client.hset("settings:trading", {
        default_leverage: "1", max_leverage: "20",
        default_take_profit_percent: "2", default_stop_loss_percent: "1",
        max_position_size: "100000",
      })
      await client.hset("settings:api", {
        api_version: "v1", rate_limit_enabled: "true",
        cors_enabled: "true", request_timeout_seconds: "30",
      })
      await client.set("_migration_last_run", new Date().toISOString())
      await client.set("_migration_total_runs", "0")
      await client.hset("features:enabled", {
        live_trading: "false", paper_trading: "true", backtesting: "true",
        strategy_optimization: "true", ai_recommendations: "false",
      })
      console.log("[v0] Migration 010: Settings and metadata finalized")
    },
    down: async (client: any) => {
      await client.del("_migration_last_run")
      await client.set("_schema_version", "9")
    },
  },
  {
    name: "011-seed-predefined-connections",
    version: 11,
    up: async (client: any) => {
      await client.set("_schema_version", "11")
      const connections = [
        { id: "bybit-x03", name: "Bybit X03", exchange: "bybit", api_type: "unified" },
        { id: "bingx-x01", name: "BingX X01", exchange: "bingx", api_type: "perpetual_futures" },
        { id: "binance-x01", name: "Binance X01", exchange: "binance", api_type: "perpetual_futures" },
        { id: "okx-x01", name: "OKX X01", exchange: "okx", api_type: "unified" },
        { id: "gateio-x01", name: "Gate.io X01", exchange: "gateio", api_type: "perpetual_futures" },
        { id: "kucoin-x01", name: "KuCoin X01", exchange: "kucoin", api_type: "perpetual_futures" },
        { id: "mexc-x01", name: "MEXC X01", exchange: "mexc", api_type: "perpetual_futures" },
        { id: "bitget-x01", name: "Bitget X01", exchange: "bitget", api_type: "perpetual_futures" },
        { id: "pionex-x01", name: "Pionex X01", exchange: "pionex", api_type: "perpetual_futures" },
        { id: "orangex-x01", name: "OrangeX X01", exchange: "orangex", api_type: "perpetual_futures" },
        { id: "huobi-x01", name: "Huobi X01", exchange: "huobi", api_type: "perpetual_futures" },
      ]

      let seededCount = 0
      for (const conn of connections) {
        try {
          const key = `connection:${conn.id}`
          const existing = await client.hgetall(key)
          if (!existing || Object.keys(existing).length === 0) {
            const storageData = {
              id: conn.id,
              name: conn.name,
              exchange: conn.exchange,
              api_key: "", // Empty - user must add real credentials
              api_secret: "", // Empty - user must add real credentials
              api_type: conn.api_type,
              connection_method: "library",
              connection_library: "native",
              margin_type: "cross",
              position_mode: "hedge",
              is_testnet: "0",
              is_enabled: "0",
              is_enabled_dashboard: "0",
              is_active: "0",
              is_predefined: "1",
              is_inserted: "0",
              is_active_inserted: "0",
              is_live_trade: "0",
              is_preset_trade: "0",
              created_at: new Date().toISOString(),
              updated_at: new Date().toISOString(),
            }
            await client.hset(key, storageData)
            await client.sadd("connections", conn.id)
            seededCount++
          }
        } catch (error) {
          console.warn(`[v0] Failed to seed ${conn.name}:`, error instanceof Error ? error.message : "unknown")
        }
      }
      console.log(`[v0] Migration 011: Seeded ${seededCount}/${connections.length} predefined template connections`)
    },
    down: async (client: any) => {
      await client.set("_schema_version", "10")
    },
  },
  {
    name: "012-finalize-dashboard-connections",
    version: 12,
    up: async (client: any) => {
      await client.set("_schema_version", "12")
      
      // Base connections: 4 primary exchange templates (bybit-x03, bingx-x01, pionex-x01, orangex-x01)
      // These are PREDEFINED TEMPLATES, not user-created connections
      // They should remain disabled by default - users must create their own credentials
      const baseTemplateIds = ["bybit-x03", "bingx-x01", "pionex-x01", "orangex-x01"]
      
      const connections = await client.smembers("connections") || []
      let updatedBase = 0
      let updatedOther = 0
      
      console.log(`[v0] Migration 012: Initializing connections (base templates set to predefined=1, disabled)`)
      
      for (const connId of connections) {
        const connData = await client.hgetall(`connection:${connId}`)
        if (!connData || Object.keys(connData).length === 0) continue
        
        if (baseTemplateIds.includes(connId)) {
          // Base templates: marked as PREDEFINED, disabled, not inserted (templates only)
          await client.hset(`connection:${connId}`, {
            is_inserted: "0",        // NOT inserted - templates only
            is_enabled: "0",         // NOT enabled by default
            is_predefined: "1",      // These are predefined templates
            is_active_inserted: "0", // NOT in active panel
            is_enabled_dashboard: "0",
            updated_at: new Date().toISOString(),
          })
          updatedBase++
          console.log(`[v0] Migration 012: ✓ ${connId} -> predefined=1, inserted=0, enabled=0 (template)`)
        } else {
          // Other predefined connections: all templates
          await client.hset(`connection:${connId}`, {
            is_inserted: "0",
            is_enabled: "0",
            is_predefined: "1",
            is_active_inserted: "0",
            is_enabled_dashboard: "0",
            updated_at: new Date().toISOString(),
          })
          updatedOther++
        }
      }
      
      console.log(`[v0] Migration 012: COMPLETE - ${updatedBase} base templates, ${updatedOther} other templates (all disabled)`)
    },
    down: async (client: any) => {
      await client.set("_schema_version", "11")
    },
  },
  {
    name: "013-risk-management-and-engines",
    version: 13,
    up: async (client: any) => {
      await client.set("_schema_version", "13")
      
      // Risk Management Settings with defaults
      await client.hset("settings:risk-management", {
        enabled: "false", // Disabled for now
        max_open_positions: "maximal",
        daily_loss_limit_percent: "65",
        max_drawdown_percent: "55",
        position_size_limit: "100000",
        stop_loss_enabled: "true",
        take_profit_enabled: "true",
      })
      
      // Trade Engine Controls
      await client.hset("settings:engines", {
        preset_trade_engine: "true", // Enabled
        main_trade_engine: "true", // Enabled
        realtime_positions_engine: "true", // Enabled
        risk_management_engine: "false", // Disabled for now
      })
      
      console.log("[v0] Migration 013: Risk management settings and engine controls added")
    },
    down: async (client: any) => {
      await client.del("settings:risk-management")
      await client.del("settings:engines")
      await client.set("_schema_version", "12")
    },
  },
  {
    name: "014-update-bingx-credentials",
    version: 14,
    up: async (client: any) => {
      await client.set("_schema_version", "14")
      
      // Only clear test/placeholder credentials (00998877 pattern, "test" prefix, too short)
      // Keep real credentials like BingX which have long valid API keys
      const exchanges = ["bybit-x03", "binance-x01", "okx-x01", "pionex-x01", "orangex-x01", "gateio-x01", "kucoin-x01", "mexc-x01", "bitget-x01", "huobi-x01"]
      
      for (const connectionId of exchanges) {
        try {
          const data = await client.hgetall(`connection:${connectionId}`)
          if (data && Object.keys(data).length > 0) {
            // Clear credentials if they're test/placeholder values (00998877 pattern)
            const apiKey = data.api_key as string
            if (apiKey && apiKey.includes("00998877")) {
              console.log(`[v0] Migration 014: Clearing test credentials from ${connectionId}`)
              await client.hset(`connection:${connectionId}`, {
                ...data,
                api_key: "",
                api_secret: "",
                updated_at: new Date().toISOString(),
              })
            }
          }
        } catch (error) {
          console.warn(`[v0] Migration 014: Could not update ${connectionId}:`, error)
        }
      }
      
      console.log(`[v0] Migration 014: Cleared test credentials, real credentials preserved`)
    },
    down: async (client: any) => {
      await client.set("_schema_version", "13")
    },
  },
  {
    name: "015-fix-connection-inserted-enabled-states",
    version: 15,
    up: async (client: any) => {
      await client.set("_schema_version", "15")
      
      // The base exchange that should be marked as INSERTED and ENABLED.
      // Bybit (bybit-x03) is no longer a canonical base connection — only bingx-x01.
      const baseExchangeIds = ["bingx-x01"]
      
      const connections = await client.smembers("connections")
      let updatedBase = 0
      let updatedOther = 0
      
      for (const connId of connections) {
        const connData = await client.hgetall(`connection:${connId}`)
        if (!connData || Object.keys(connData).length === 0) continue
        
        if (baseExchangeIds.includes(connId)) {
          // Mark as INSERTED and ENABLED in Settings by default (base connection)
          // Dashboard/Main enable toggle stays OFF by default until user enables it.
          await client.hset(`connection:${connId}`, {
            is_inserted: "1",
            is_enabled: "1",              // ENABLED by default
            is_active_inserted: "1",      // Added to Active panel
            is_enabled_dashboard: "0",    // Dashboard toggle OFF by default
            is_active: "0",
            is_predefined: "1",
            connection_method: "library", // Use native SDK by default
            updated_at: new Date().toISOString(),
          })
          updatedBase++
          console.log(`[v0] Migration 015: ${connId} -> inserted=1, enabled=1, active_inserted=1, dashboard_enabled=0 (base connection)`)
        } else {
          // Non-base predefined connections: just informational templates
          // NOT inserted, NOT enabled - they are templates only
          await client.hset(`connection:${connId}`, {
            is_inserted: "0",
            is_enabled: "0",
            is_predefined: "1",
            is_enabled_dashboard: "0",
            updated_at: new Date().toISOString(),
          })
          updatedOther++
          console.log(`[v0] Migration 015: ${connId} -> inserted=0, enabled=0 (template only)`)
        }
      }
      
      console.log(`[v0] Migration 015: Fixed ${updatedBase} base connections, ${updatedOther} template connections`)
    },
    down: async (client: any) => {
      await client.set("_schema_version", "14")
    },
  },
  {
    name: "016-active-connections-independent-state",
    version: 16,
    up: async (client: any) => {
      await client.set("_schema_version", "16")
      
// Migration 016: Ensure canonical base connections are properly set up with predefined real credentials.
       // Bybit (bybit-x03) is no longer canonical — only bingx-x01 is auto-seeded.
       // NOTE: is_active_inserted is NOT set here - user must explicitly assign to main via dashboard.
       const baseTemplateIds = ["bingx-x01"]
       
       const connections = await client.smembers("connections") || []
       let updatedTemplates = 0
       let updatedUserConnections = 0
       
       console.log(`[v0] Migration 016: Ensuring predefined templates state for ${connections.length} connections`)
       
       for (const connId of connections) {
         const connData = await client.hgetall(`connection:${connId}`)
         if (!connData || Object.keys(connData).length === 0) continue
         
         const isPredefined = connData.is_predefined === "1" || connData.is_predefined === true
         const isBaseTemplate = baseTemplateIds.includes(connId)
         
         if (isBaseTemplate) {
           // Base connections: inserted and enabled in Settings by default
           // Main (dashboard) enable toggle must remain OFF by default.
           // is_active_inserted is NOT set - user must explicitly assign to main connections panel
           const updateData: Record<string, string> = {
             is_inserted: "1",        // INSERTED (visible in Settings base panel)
             is_enabled: "1",         // ENABLED (independent system flag)
             is_active_inserted: "0", // NOT in Active panel - user must explicitly assign
             is_enabled_dashboard: "0", // Dashboard toggle OFF by default
             is_active: "0",          // Derived: is_active_inserted AND is_enabled_dashboard
             connection_method: "library", // Use native SDK by default
             updated_at: new Date().toISOString(),
           }
           
           if (baseTemplateIds.includes(connId)) {
             const credentials = getBaseConnectionCredentials(connId as BaseConnectionId)
             updateData.api_key = credentials.apiKey
             updateData.api_secret = credentials.apiSecret
           }
           
           await client.hset(`connection:${connId}`, updateData)
           updatedTemplates++
           console.log(`[v0] Migration 016: ✓ ${connId} -> inserted=1, enabled=1, dashboard_enabled=0 (base connection)`)
         } else if (!isPredefined) {
           // User-created connections: reset dashboard state if not properly set
           if (!connData.is_active_inserted || !connData.is_enabled_dashboard) {
             await client.hset(`connection:${connId}`, {
               is_active_inserted: "0",      // Default: NOT in active panel
               is_enabled_dashboard: "0",    // Default: NOT enabled
               is_enabled: connData.is_enabled || "0",  // Preserve existing enabled state
               updated_at: new Date().toISOString(),
             })
             updatedUserConnections++
             console.log(`[v0] Migration 016: ✓ ${connId} reset dashboard state to defaults`)
           }
         }
       }
       
       console.log(`[v0] Migration 016: COMPLETE - ${updatedTemplates} templates verified, ${updatedUserConnections} user connections updated`)
    },
    down: async (client: any) => {
      await client.set("_schema_version", "15")
    },
  },
  {
    name: "017-cleanup-base-connections-to-bybit-bingx-only",
    version: 17,
    up: async (client: any) => {
      await client.set("_schema_version", "17")
      
      // Cleanup migration: Reset all connections to proper state
      // Only bingx-x01 should be a base connection (inserted=1, enabled=1)
      // All others (pionex, orangex, binance, etc) should be templates only (inserted=0, enabled=0)
      const baseExchangeIds = ["bingx-x01"]
      
      const connections = await client.smembers("connections")
      let cleanedBase = 0
      let cleanedTemplates = 0
      
      for (const connId of connections) {
        const connData = await client.hgetall(`connection:${connId}`)
        if (!connData || Object.keys(connData).length === 0) continue
        
        if (baseExchangeIds.includes(connId)) {
          // Base connection: ensure proper state in BASE connections only
          // NOTE: is_active_inserted is NOT set here - user must explicitly assign to main
          await client.hset(`connection:${connId}`, {
            is_inserted: "1",
            is_enabled: "1",
            is_active_inserted: "0",      // NOT auto-assigned to main - user must explicitly do this
            is_enabled_dashboard: "0",    // UI toggle OFF by default
            is_active: "0",
            is_predefined: "1",
            connection_method: "library",
            updated_at: new Date().toISOString(),
          })
          cleanedBase++
          console.log(`[v0] Migration 017: ✓ ${connId} -> corrected to base connection state`)
        } else {
          // Non-base connection: ensure template state
          // Reset to template-only state to prevent auto-assignment
          await client.hset(`connection:${connId}`, {
            is_inserted: "0",
            is_enabled: "0",
            is_active_inserted: "0",
            is_enabled_dashboard: "0",
            is_active: "0",
            is_predefined: "1",
            updated_at: new Date().toISOString(),
          })
          cleanedTemplates++
          console.log(`[v0] Migration 017: ✓ ${connId} -> corrected to template-only state`)
        }
      }
      
      console.log(`[v0] Migration 017: COMPLETE - ${cleanedBase} base connections, ${cleanedTemplates} templates cleaned up`)
    },
    down: async (client: any) => {
      await client.set("_schema_version", "16")
    },
  },
  {
    name: "018-remove-auto-assignment-from-main-connections",
    version: 18,
    up: async (client: any) => {
      await client.set("_schema_version", "18")
      
      // Fix: Remove auto-assignment from main connections
      // Connections should only be in main if user explicitly assigned them
      const connections = await client.smembers("connections")
      let fixed = 0
      
      for (const connId of connections) {
        const connData = await client.hgetall(`connection:${connId}`)
        if (!connData || Object.keys(connData).length === 0) continue
        
        // If connection has is_active_inserted="1" but no explicit user action,
        // reset it to NOT assigned to main connections
        // Only keep assignment if dashboard is enabled (user intent)
        const isDashboardEnabled = connData.is_enabled_dashboard === "1" || connData.is_enabled_dashboard === "true"
        const isActiveInserted = connData.is_active_inserted === "1" || connData.is_active_inserted === "true"
        
        if (isActiveInserted && !isDashboardEnabled) {
          // Reset to not assigned - user must explicitly add to main
          await client.hset(`connection:${connId}`, {
            is_active_inserted: "0",
            updated_at: new Date().toISOString(),
          })
          fixed++
          console.log(`[v0] Migration 018: ✓ ${connId} -> removed auto-assignment (dashboard not enabled)`)
        }
      }
      
      console.log(`[v0] Migration 018: COMPLETE - fixed ${fixed} connections that were auto-assigned`)
    },
    down: async (client: any) => {
      await client.set("_schema_version", "17")
    },
  },
  {
    // Version 19 was intentionally skipped during a refactor cycle — this tombstone
    // prevents the gap from causing confusion if a v19 migration is ever introduced
    // later, and ensures any system that somehow stored "_schema_version"="19" in
    // Redis is still advanced to v20 on the next startup.
    name: "019-tombstone-skipped-version",
    version: 19,
    up: async (client: any) => {
      await client.set("_schema_version", "19")
      console.log("[v0] Migration 019: tombstone — version 19 was intentionally skipped")
    },
    down: async (client: any) => {
      await client.set("_schema_version", "18")
    },
  },
  {
    name: "020-phase3-database-consolidation",
    version: 20,
    up: async (client: any) => {
      await client.set("_schema_version", "20")
      
      console.log(`[v0] Migration 020: PHASE 3 - Database consolidation starting...`)
      
      // PHASE 3 FIX: Consolidate progression keys
      const connections = await client.smembers("connections")
      let consolidated = 0
      
      for (const connId of connections) {
        try {
          // Read from old scattered keys
          const oldProgression = await client.hgetall(`progression:${connId}`)
          const oldEngineState = await client.hgetall(`engine_state:${connId}`)
          const oldTradeEngineState = await client.hgetall(`trade_engine_state:${connId}`)
          
          // Build unified structure
          const unified = {
            cycles_completed: oldProgression?.cycles_completed || "0",
            successful_cycles: oldProgression?.successful_cycles || "0",
            failed_cycles: oldProgression?.failed_cycles || "0",
            phase: oldProgression?.phase || oldTradeEngineState?.phase || "idle",
            phase_progress: oldProgression?.progress || oldEngineState?.progress || "0",
            phase_message: oldProgression?.detail || oldEngineState?.detail || "",
            engine_started: oldEngineState?.started_at || oldTradeEngineState?.started_at || "",
            last_cycle: oldProgression?.last_cycle || "",
            last_indication_count: oldProgression?.indication_count || "0",
            last_strategy_count: oldProgression?.strategy_count || "0",
            symbols_count: oldTradeEngineState?.symbols_count || "0",
            updated_at: new Date().toISOString(),
          }
          
          // Write unified structure
          await client.hset(`progression:${connId}`, unified)
          
          // Set TTL on old keys for backward compatibility (24 hours)
          await client.expire(`progression:${connId}:cycles`, 86400)
          await client.expire(`progression:${connId}:indications`, 86400)
          await client.expire(`engine_state:${connId}`, 86400)
          
          consolidated++
        } catch (e) {
          console.warn(`[v0] Migration 020: Error consolidating ${connId}:`, e)
        }
      }
      
      // PHASE 3 FIX: Create connection indexes
      // Index 1: Main enabled connections
      for (const connId of connections) {
        const connData = await client.hgetall(`connection:${connId}`)
        const isAssigned = connData?.is_assigned === "1" || connData?.is_assigned === "true"
        const isDashboardEnabled = connData?.is_enabled_dashboard === "1" || connData?.is_enabled_dashboard === "true"
        
        if (isAssigned && isDashboardEnabled) {
          await client.sadd("connections:main:enabled", connId)
        }
        
        // Index 2: Exchange-specific
        if (connData?.exchange) {
          await client.sadd(`connections:exchange:${connData.exchange.toLowerCase()}`, connId)
        }
        
        // Index 3: Base enabled
        const isInserted = connData?.is_inserted === "1" || connData?.is_inserted === "true"
        const isBaseEnabled = connData?.is_enabled === "1" || connData?.is_enabled === "true"
        
        if (isInserted && isBaseEnabled) {
          await client.sadd("connections:base:enabled", connId)
        }
        
        // Index 4: Working connections
        if (connData?.last_test_status === "success") {
          await client.sadd("connections:working", connId)
        }
      }
      
      console.log(`[v0] Migration 020: ✓ Consolidated ${consolidated} progression structures`)
      console.log(`[v0] Migration 020: ✓ Created ${connections.length} connection indexes`)
      console.log(`[v0] Migration 020: COMPLETE - Database consolidation done`)
    },
    down: async (client: any) => {
      // Note: Rollback is not implemented for this migration (destructive)
      // Users should restore from backup if needed
      await client.set("_schema_version", "19")
    },
  },
  {
    name: "021-restore-dashboard-enabled-for-auto-active-base-connections",
    version: 21,
    up: async (client: any) => {
      await client.set("_schema_version", "21")

      // AUTO-START DISABLED (no-op): this migration previously force-set
      // is_enabled_dashboard=1 / is_assigned=1 / is_active=1 for autoActive
      // base connections (bingx-x01), which made connections auto-start on
      // every fresh DB. Connections must now be enabled explicitly by the
      // operator via the dashboard toggle. The version stamp above is kept
      // so the migration chain stays contiguous.
      console.log(`[v0] Migration 021: no-op (auto-enable removed; operator must enable connections manually)`)
    },
    down: async (client: any) => {
      await client.set("_schema_version", "20")
      for (const connId of ["bingx-x01"]) {
        await client.hset(`connection:${connId}`, { is_enabled_dashboard: "0", is_active: "0" })
      }
    },
  },
  {
    name: "022-comprehensive-data-structure-consistency",
    version: 22,
    up: async (client: any) => {
      await client.set("_schema_version", "22")
      
      // Comprehensive data structure validation and repair migration
      // Ensures all required keys, indexes, and data structures are present
      
      console.log(`[v0] Migration 022: Starting comprehensive data structure validation...`)
      
      let fixed = 0
      let validated = 0
      
      // ── 1. Validate and fix strategy progression keys ─────────────
      const connections = await client.smembers("connections:main:enabled") || []
      
      for (const connId of connections) {
        try {
          // Ensure progression container exists for each connection
          const keysPrefix = `strategies:${connId}`
          const indices = [
            { key: `${keysPrefix}:indices`, description: "Connection indices" },
            { key: `strategy_count:${connId}`, description: "Total strategy count" },
            { key: `real_pi_acc:${connId}`, description: "Real position accumulation" },
            { key: `axis_pos_acc:${connId}`, description: "Axis position accumulation" },
          ]
          
          for (const { key, description } of indices) {
            const exists = await client.exists(key)
            if (!exists) {
              // Initialize with empty marker
              await client.hset(key, "_initialized", "1")
              fixed++
              console.log(`[v0] Migration 022: Created ${description} key: ${key}`)
            }
            validated++
          }
          
          // Ensure progression metadata exists
          const progMetadata = `progression:${connId}:metadata`
          const metaExists = await client.exists(progMetadata)
          if (!metaExists) {
            await client.hset(progMetadata, {
              created_at: new Date().toISOString(),
              last_cycle: new Date().toISOString(),
              total_base_created: "0",
              total_main_created: "0",
              total_real_created: "0",
              total_live_created: "0",
            })
            fixed++
            console.log(`[v0] Migration 022: Created progression metadata for ${connId}`)
          }
          validated++
          
          // Ensure per-symbol tracking sets exist
          const symbols = await client.smembers(`${keysPrefix}:symbols`) || []
          for (const symbol of symbols) {
            const symbolSets = [
              `${keysPrefix}:${symbol}:base:sets`,
              `${keysPrefix}:${symbol}:main:sets`,
              `${keysPrefix}:${symbol}:real:sets`,
              `${keysPrefix}:${symbol}:live:sets`,
            ]
            
            for (const setKey of symbolSets) {
              const isSet = await client.type(setKey)
              if (isSet === "none") {
                // Initialize as empty set with marker
                await client.sadd(setKey, "_init")
                await client.srem(setKey, "_init")
                fixed++
                console.log(`[v0] Migration 022: Initialized set key: ${setKey}`)
              }
              validated++
            }
          }
        } catch (err) {
          console.warn(`[v0] Migration 022: Error validating connection ${connId}:`, err)
        }
      }
      
      // ── 2. Validate position history structures ──────────────────
      try {
        const historyKeys = await client.keys("pi_history:*")
        console.log(`[v0] Migration 022: Found ${historyKeys.length} position history keys`)
        validated += historyKeys.length
        
        // Each position history hash should have standard fields
        for (const key of historyKeys) {
          const data = await client.hgetall(key)
          const requiredFields = ["count", "wins", "losses", "pf_num_x1000", "pf_den_x1000", "ddt_num_x10"]
          const hasAllFields = requiredFields.every(f => f in data || data[f] !== undefined)
          
          if (!hasAllFields) {
            // Repair by ensuring all fields exist
            const updates: Record<string, string> = {}
            for (const field of requiredFields) {
              if (!(field in data)) {
                updates[field] = "0"
              }
            }
            if (Object.keys(updates).length > 0) {
              await client.hset(key, updates)
              fixed++
              console.log(`[v0] Migration 022: Repaired position history key: ${key}`)
            }
          }
          validated++
        }
      } catch (err) {
        console.warn(`[v0] Migration 022: Error validating position history:`, err)
      }
      
      // ── 3. Validate axis position accumulation ledgers ──────────
      try {
        const axisKeys = await client.keys("axis_pos_acc:*")
        console.log(`[v0] Migration 022: Found ${axisKeys.length} axis position accumulation keys`)
        validated += axisKeys.length
        
        // Axis ledgers should have accumulation data
        for (const key of axisKeys) {
          const exists = await client.exists(key)
          if (exists) {
            // Check TTL is set (90 days)
            const ttl = await client.ttl(key)
            if (ttl === -1) {
              // No expiry set, add it
              await client.expire(key, 90 * 24 * 60 * 60)
              fixed++
              console.log(`[v0] Migration 022: Set expiry on axis ledger: ${key}`)
            }
          }
          validated++
        }
      } catch (err) {
        console.warn(`[v0] Migration 022: Error validating axis accumulation:`, err)
      }
      
      // ── 4. Validate hedge bucket structures ─────────────────────
      try {
        const hedgeKeys = await client.keys("live_net_target:*")
        console.log(`[v0] Migration 022: Found ${hedgeKeys.length} hedge net target keys`)
        validated += hedgeKeys.length
        
        // Each should contain direction:remainder pairs
        for (const key of hedgeKeys) {
          const value = await client.get(key)
          if (!value || !value.includes(":")) {
            // Repair with neutral default
            await client.set(key, "flat:0")
            fixed++
            console.log(`[v0] Migration 022: Repaired hedge target: ${key}`)
          }
          validated++
        }
      } catch (err) {
        console.warn(`[v0] Migration 022: Error validating hedge structures:`, err)
      }
      
      console.log(`[v0] Migration 022: COMPLETE`)
      console.log(`  - Fixed: ${fixed} keys/structures`)
      console.log(`  - Validated: ${validated} keys`)
      console.log(`[v0] Migration 022: Data structure consistency check finished`)
    },
    down: async (client: any) => {
      await client.set("_schema_version", "21")
    },
  },
  {
    name: "023-eval-knob-hash-defaults",
    version: 23,
    up: async (client: any) => {
      await client.set("_schema_version", "23")

      // Backfill the windowed-eval knobs into the `connection_settings:{id}`
      // HASH that the strategy coordinator + detailed-tracking read via
      // hgetall. Before this migration that hash was never populated (the
      // settings PATCH route only wrote the connection JSON object), so the
      // engine silently ran the built-in defaults and operator changes to
      // these values never took effect. Seeding spec defaults here gives
      // dev + prod identical, non-empty starting state from first boot;
      // the PATCH route now keeps the hash in sync on every save.
      //
      // Idempotent: we read the hash first and only write fields that are
      // absent, so an operator who already tuned a value (via the now-wired
      // PATCH path) is never clobbered, and re-running the migration is a
      // no-op. The InlineLocalRedis emulator has no hsetnx, so set-if-absent
      // is emulated with hgetall + conditional hset.
      const SPEC_DEFAULTS: Record<string, string> = {
        prevPosMinCount: "5",   // min closed positions before historic blend activates
        prevPosWindow:   "25",  // single cumulative last-N window feeding BOTH windowed PF and DDT
        mainEvalPosCount: "3",  // Main-stage validation min position count (3 = bootstrap-safe; historic full-run default was 15)
        realEvalPosCount: "3",  // Real-stage validation min position count
      }

      // Union of every connection id source so we don't miss disabled /
      // template connections (they still get evaluated when toggled on).
      // The CANONICAL source is `keys("connection:*")` — the same one
      // getAllConnections uses — because nobody populates a `connections`
      // SET and `connections:main:enabled` only holds ENABLED ids, so a
      // disabled connection would otherwise never get its defaults seeded
      // and would silently run built-ins the moment it's toggled on.
      const idSet = new Set<string>()
      try {
        const connKeys = (await client.keys("connection:*")) || []
        for (const k of connKeys) {
          if (typeof k !== "string") continue
          // Skip the `connection_settings:*` hashes themselves.
          if (k.startsWith("connection_settings:")) continue
          const id = k.slice("connection:".length)
          if (id) idSet.add(id)
        }
      } catch { /* keys() unavailable — fall through to the set-based sources */ }
      for (const setName of ["connections", "connections:main:enabled"]) {
        try {
          const ids = (await client.smembers(setName)) || []
          for (const id of ids) if (typeof id === "string" && id) idSet.add(id)
        } catch { /* missing set = nothing to add */ }
      }

      let seeded = 0
      for (const connId of idSet) {
        const key = `connection_settings:${connId}`
        const existing = (await client.hgetall(key).catch(() => ({}))) as
          | Record<string, string>
          | null
        const have = existing || {}
        const toWrite: Record<string, string> = {}
        for (const [field, value] of Object.entries(SPEC_DEFAULTS)) {
          if (have[field] === undefined || have[field] === null || have[field] === "") {
            toWrite[field] = value
          }
        }
        if (Object.keys(toWrite).length > 0) {
          await client.hset(key, toWrite)
          seeded += Object.keys(toWrite).length
        }
      }

      console.log(
        `[v0] Migration 023: Seeded eval-knob defaults for ${idSet.size} connections (${seeded} fields written)`,
      )
    },
    down: async (client: any) => {
      await client.set("_schema_version", "22")
    },
  },
  {
    name: "024-ddt-window-unify-and-stage-thresholds",
    version: 24,
    up: async (client: any) => {
      await client.set("_schema_version", "24")

      // ── Part A: remove the orphaned `ddtCapPositions` hash field ────────
      // PF and DDT now share ONE cumulative last-N window (`prevPosWindow`).
      // The separate `ddtCapPositions` knob was a misunderstanding (DDT is a
      // *time* ceiling, not a position count) and has been removed from the
      // UI, dialog, PATCH route, coordinator, and the v23 seed. Strip the
      // now-dead field from every connection_settings hash so stale values
      // can't confuse future readers. Idempotent: hdel on an absent field is
      // a harmless no-op.
      const idSet = new Set<string>()
      try {
        const connKeys = (await client.keys("connection:*")) || []
        for (const k of connKeys) {
          if (typeof k !== "string") continue
          if (k.startsWith("connection_settings:")) continue
          const id = k.slice("connection:".length)
          if (id) idSet.add(id)
        }
      } catch { /* keys() unavailable — fall through */ }
      for (const setName of ["connections", "connections:main:enabled"]) {
        try {
          const ids = (await client.smembers(setName)) || []
          for (const id of ids) if (typeof id === "string" && id) idSet.add(id)
        } catch { /* missing set */ }
      }
      let stripped = 0
      for (const connId of idSet) {
        try {
          const removed = await client.hdel(`connection_settings:${connId}`, "ddtCapPositions")
          if (Number(removed) > 0) stripped++
        } catch { /* hdel unsupported / absent — ignore */ }
      }

      // ── Part B: seed per-stage Max Drawdown-Time ceilings (hours) ───────
      // The DDT gate threshold is now operator-tunable per stage and was
      // previously never loaded from settings (the engine ran a hardcoded
      // 5h). Per-position hold is up to ~2h, so the default ceiling is 4h
      // per stage. Seed the canonical `app_settings` hash if absent, so the
      // gate has explicit, non-stale values from first boot. Idempotent via
      // hgetall + conditional hset (no hsetnx in the emulator).
      const APP_DDT_DEFAULTS: Record<string, string> = {
        maxDrawdownTimeMainHours: "4",
        maxDrawdownTimeRealHours: "4",
        maxDrawdownTimeLiveHours: "4",
      }
      let appSeeded = 0
      try {
        const existing = (await client.hgetall("app_settings").catch(() => ({}))) as
          | Record<string, string>
          | null
        const have = existing || {}
        const toWrite: Record<string, string> = {}
        for (const [field, value] of Object.entries(APP_DDT_DEFAULTS)) {
          if (have[field] === undefined || have[field] === null || have[field] === "") {
            toWrite[field] = value
          }
        }
        if (Object.keys(toWrite).length > 0) {
          await client.hset("app_settings", toWrite)
          appSeeded = Object.keys(toWrite).length
        }
      } catch { /* app_settings unavailable — engine falls back to 4h default */ }

      console.log(
        `[v0] Migration 024: unified PF/DDT window — stripped ddtCapPositions from ${stripped} connections, seeded ${appSeeded} app-level DDT-threshold defaults`,
      )
    },
    down: async (client: any) => {
      await client.set("_schema_version", "23")
    },
  },
  {
    name: "025-initialize-progression-state-hashes",
    version: 25,
    up: async (client: any) => {
      await client.set("_schema_version", "25")

      // ── Initialize progression:{connectionId} hashes for all connections ────
      // These hashes track counters, snapshots, and cycle metrics for each
      // connection's trade engine. Previously they were created on-demand
      // (lazy initialization) when the first log event fired. This created
      // a race condition during crashes: if Redis crashed after migrations
      // completed but BEFORE the engine's first progression write, the hash
      // didn't exist, causing missing or corrupted progression state.
      //
      // IMPACT: This ensures every connection has a valid progression hash
      // with zeroed counters + default values at startup, so any subsequent
      // crash doesn't leave the progression state missing or incomplete.
      //
      // IDEMPOTENT: If a progression hash already exists, hgetall returns
      // the existing fields, and we only hset the missing defaults. The
      // existing counters and snapshots are preserved.

      // ── DEADLOCK FIX: Use raw client, NOT getAllConnections() ────────────────
      // getAllConnections() calls initRedis() internally. Since we are already
      // INSIDE initRedis() running migrations, that creates a circular wait that
      // deadlocks the entire server (event loop blocked, all routes timeout).
      // Use client.keys() directly ������� exactly as migrations 020-024 do.
      const idSet025 = new Set<string>()
      try {
        const connKeys025 = (await client.keys("connection:*")) || []
        for (const k of connKeys025) {
          if (typeof k !== "string") continue
          if (k.startsWith("connection_settings:")) continue
          const id = k.slice("connection:".length)
          if (id) idSet025.add(id)
        }
      } catch { /* keys() unavailable */ }
      for (const setName025 of ["connections", "connections:main:enabled"]) {
        try {
          const ids = (await client.smembers(setName025)) || []
          for (const id of ids) if (typeof id === "string" && id) idSet025.add(id)
        } catch { /* missing set */ }
      }

      const now = new Date().toISOString()
      const epochMs = Date.now()

      for (const connId025 of idSet025) {
        const progKey = `progression:${connId025}`

        // Read current state (if any)
        const existing = (await client.hgetall(progKey).catch(() => ({}))) as
          | Record<string, string>
          | null
        const have = existing || {}

        // Default progression state structure — write only missing fields
        const defaults: Record<string, string> = {
          // ── Identity & Session ──
          connection_id: connId025,
          session_number: have.session_number ?? "0",
          epoch: have.epoch ?? String(epochMs),
          started_at: have.started_at ?? String(epochMs),

          // ── Cycle Counters (hincrby discipline — never overwrite!) �����������������
          cycles_completed: have.cycles_completed ?? "0",
          successful_cycles: have.successful_cycles ?? "0",
          failed_cycles: have.failed_cycles ?? "0",

          // ── Per-Processor Counters ──
          indication_cycle_count: have.indication_cycle_count ?? "0",
          indication_live_cycle_count: have.indication_live_cycle_count ?? "0",
          strategy_cycle_count: have.strategy_cycle_count ?? "0",
          strategy_live_cycle_count: have.strategy_live_cycle_count ?? "0",
          realtime_cycle_count: have.realtime_cycle_count ?? "0",
          realtime_live_cycle_count: have.realtime_live_cycle_count ?? "0",
          frames_processed: have.frames_processed ?? "0",

          // ── Indication Type Counters ──
          indications_direction_count: have.indications_direction_count ?? "0",
          indications_move_count: have.indications_move_count ?? "0",
          indications_active_count: have.indications_active_count ?? "0",
          indications_active_advanced_count: have.indications_active_advanced_count ?? "0",
          indications_optimal_count: have.indications_optimal_count ?? "0",
          indications_auto_count: have.indications_auto_count ?? "0",

          // ── Strategy Set Counters ──
          strategies_base_total: have.strategies_base_total ?? "0",
          strategies_base_evaluated: have.strategies_base_evaluated ?? "0",
          strategies_main_total: have.strategies_main_total ?? "0",
          strategies_main_evaluated: have.strategies_main_evaluated ?? "0",
          strategies_real_total: have.strategies_real_total ?? "0",
          strategies_real_evaluated: have.strategies_real_evaluated ?? "0",

          // ── Trade / Profit Counters ──
          total_trades: have.total_trades ?? "0",
          successful_trades: have.successful_trades ?? "0",
          total_profit: have.total_profit ?? "0",

          // ── Snapshot Fields (hset discipline) ──
          cycle_success_rate: have.cycle_success_rate ?? "0",
          trade_success_rate: have.trade_success_rate ?? "0",
          cycle_time_ms: have.cycle_time_ms ?? "0",
          last_cycle_time: have.last_cycle_time ?? now,
          last_update: have.last_update ?? now,

          // ── Engine State ──
          engine_started: have.engine_started ?? "false",
          prehistoric_phase_active: have.prehistoric_phase_active ?? "false",
          prehistoric_symbols_processed_count: have.prehistoric_symbols_processed_count ?? "0",
          prehistoric_candles_processed: have.prehistoric_candles_processed ?? "0",
          intervals_processed: have.intervals_processed ?? "0",
          indications_count: have.indications_count ?? "0",
          indication_sets_total: have.indication_sets_total ?? "0",
          indication_sets_at_limit: have.indication_sets_at_limit ?? "0",
          strategies_count: have.strategies_count ?? "0",
        }

        // Write only missing fields — preserve existing counters
        const toWrite: Record<string, string> = {}
        for (const [field, value] of Object.entries(defaults)) {
          if (have[field] === undefined || have[field] === null || have[field] === "") {
            toWrite[field] = value
          }
        }

        if (Object.keys(toWrite).length > 0) {
          await client.hset(progKey, toWrite)
        }
      }

      // Also initialize the global progression index (if needed by monitoring)
      const progressionIndex = (await client.hgetall("progression:index").catch(() => ({}))) as
        | Record<string, string>
        | null
      const haveIndex = progressionIndex || {}
      if (!haveIndex.total_connections) {
        await client.hset("progression:index", {
          total_connections: String(idSet025.size),
          last_initialized: now,
          schema_version: "25",
        })
      }

      console.log(
        `[v0] Migration 025: initialized progression state for ${idSet025.size} connections (defaults for missing fields, preserved existing counters)`,
      )
    },
    down: async (client: any) => {
      await client.set("_schema_version", "24")
    },
  },
  {
    name: "026-per-connection-pf-ddt-leverage-defaults",
    version: 26,
    up: async (client: any) => {
      await client.set("_schema_version", "26")

      // ── Backfill per-connection PF/DDT/stage-min-pos/leverage defaults ───────
      //
      // The strategy coordinator reads per-connection overrides from
      // `connection_settings:{id}` (written by the settings PATCH route).
      // On a cold boot / fresh install these hashes don't exist yet, so the
      // coordinator falls back to global app_settings → built-in defaults.
      // This migration seeds the canonical defaults into every connection's
      // hash so:
      //   1. The coordinator's resolution chain (connection > global > default)
      //      finds the values on first load without waiting for the operator
      //      to visit Settings → Strategy and save.
      //   2. The Settings PATCH route's idempotent "set-if-absent" logic
      //      (which never clobbers operator-tuned values) is satisfied.
      //
      // Defaults per spec:
      //   baseProfitFactor=0.9   ��� admission floor for Base stage
      //   main/real/liveProfitFactor=1.0
      //   maxDrawdownTimeMainHours=4  maxDrawdownTimeRealHours=4  maxDrawdownTimeLiveHours=4
      //   stageMinPosCountBase=1  stageMinPosCountMain=1  stageMinPosCountReal=1
      //   leveragePercentage=100  useMaximalLeverage=false
      //
      // IDEMPOTENT: hgetall + set-only-if-absent so re-running on a DB with
      // operator-tuned values never overwrites the operator's choices.
      //
      // DEADLOCK-SAFE: uses raw client.keys() — never calls getAllConnections()
      // (which calls initRedis() internally and would deadlock since we are
      // already inside initRedis() running migrations).

      const idSet026 = new Set<string>()
      try {
        const connKeys026 = (await client.keys("connection:*")) || []
        for (const k of connKeys026) {
          if (typeof k !== "string") continue
          if (k.startsWith("connection_settings:")) continue
          const id = k.slice("connection:".length)
          if (id) idSet026.add(id)
        }
      } catch { /* keys() unavailable */ }
      for (const setName026 of ["connections", "connections:main:enabled"]) {
        try {
          const ids = (await client.smembers(setName026)) || []
          for (const id of ids) if (typeof id === "string" && id) idSet026.add(id)
        } catch { /* missing set */ }
      }

      const DEFAULTS_026: Record<string, string> = {
        baseProfitFactor:             "0.9",
        mainProfitFactor:             "1.0",
        realProfitFactor:             "1.0",
        liveProfitFactor:             "1.0",
        maxDrawdownTimeMainHours:     "4",
        maxDrawdownTimeRealHours:     "4",
        maxDrawdownTimeLiveHours:     "4",
        stageMinPosCountBase:         "1",
        stageMinPosCountMain:         "1",
        stageMinPosCountReal:         "1",
        leveragePercentage:           "100",
        useMaximalLeverage:           "false",
      }

      let seeded = 0
      for (const connId026 of idSet026) {
        const key = `connection_settings:${connId026}`
        // Read existing hash — emulator has no hsetnx so we simulate
        // it with hgetall + conditional hset.
        const existing = (await client.hgetall(key).catch(() => null)) as
          | Record<string, string>
          | null
        const have = existing || {}

        const toWrite: Record<string, string> = {}
        for (const [field, val] of Object.entries(DEFAULTS_026)) {
          // Only set when the field is absent or blank — never overwrite
          // operator-tuned values.
          if (have[field] === undefined || have[field] === null || have[field] === "") {
            toWrite[field] = val
          }
        }
        if (Object.keys(toWrite).length > 0) {
          await client.hset(key, toWrite)
          seeded += Object.keys(toWrite).length
        }
      }

      console.log(
        `[v0] Migration 026: seeded per-connection PF/DDT/leverage defaults for ${idSet026.size} connections (${seeded} fields written)`,
      )
    },
    down: async (client: any) => {
      await client.set("_schema_version", "25")
    },
  },
  {
    name: "027-engine-timings-defaults-in-settings-system",
    version: 27,
    up: async (client: any) => {
      await client.set("_schema_version", "27")

      // ── Seed engine-timing defaults into `settings:system` ───────────────
      //
      // Prior to this migration `settings:system` had no engine-timing keys,
      // so `getEngineTimings()` fell back to DEFAULT_ENGINE_TIMINGS on every
      // load.  Seeding the defaults explicitly:
      //   1. Makes the effective configuration visible and auditable via the
      //      Settings → System → Engine Timings panel.
      //   2. Ensures that operator changes persisted through the UI are
      //      preserved across cold-boots (they already are, but only if the
      //      key exists — otherwise a flush would reset them invisibly).
      //   3. Removes the previous livePositionsCyclePauseMs bounds/default
      //      mismatch confusion: the stored value is 300 ms, the bound max
      //      is now 500 ms, so `clamp(300, {min:10,max:500}) = 300` (no
      //      longer silently clamped to 200).
      //
      // IDEMPOTENT: hgetall + conditional-hset, never overwrites operator
      // values that already exist in the hash.

      const TIMING_DEFAULTS_027: Record<string, string> = {
        // Live-sync start-to-start cadence for syncWithExchange (Loop C).
        // Kept at 200 ms so close/fill detection fires 5 times/sec.
        // This value must never be raised above 1000 ms — doing so would
        // allow BingX-filled close orders to remain open in Redis for >1 s,
        // causing incorrect PnL and double-close attempts.
        live_sync_interval_ms:           "200",
        live_sync_pause_ms:              "50",
        live_positions_cycle_pause_ms:   "300",
        realtime_cycle_pause_ms:         "200",
        realtime_interval_ms:            "300",
        prehistoric_interval_ms:         "5000",
        prehistoric_cycle_pause_ms:      "50",
        strategy_flow_min_interval_ms:   "5000",
        strategy_flow_hard_throttle_ms:  "10000",
        strategy_flow_max_interval_ms:   "30000",
        lock_extend_interval_ms:         "30000",
        max_position_hold_ms:            "14400000",
        progression_buffer_flush_ms:     "5000",
      }

      const existing027 = (await client.hgetall("settings:system").catch(() => null)) as
        | Record<string, string>
        | null
      const have027 = existing027 || {}

      const toWrite027: Record<string, string> = {}
      for (const [field, val] of Object.entries(TIMING_DEFAULTS_027)) {
        if (have027[field] === undefined || have027[field] === null || have027[field] === "") {
          toWrite027[field] = val
        }
      }

      if (Object.keys(toWrite027).length > 0) {
        await client.hset("settings:system", toWrite027)
      }

      console.log(
        `[v0] Migration 027: seeded ${Object.keys(toWrite027).length} engine-timing defaults into settings:system`,
      )
    },
    down: async (client: any) => {
      await client.set("_schema_version", "26")
    },
  },
  {
    name: "028-pin-live-sync-interval-and-min-step",
    version: 28,
    up: async (client: any) => {
      await client.set("_schema_version", "28")

      // ── 1. Pin live_sync_interval_ms = 200 in settings:system ────────────
      //
      // Migration v27 omitted `live_sync_interval_ms` from its seed block,
      // so instances that already ran v27 have no stored value — they fall
      // back to the DEFAULT_ENGINE_TIMINGS constant (200 ms), which is correct,
      // but the value is invisible to the settings UI and would revert to
      // whatever the constant is if the code changes. Pinning it explicitly
      // at 200 ms:
      //   • Makes the value visible and auditable in Settings → System → Timings
      //   • Survives DB flushes
      //   • Documents the intent: LIVE_SYNC_INTERVAL_MS must stay at 200 ms
      //     (5 sweeps/sec) so fill/close detection is timely
      //
      // IDEMPOTENT: only writes if the key is absent or empty.
      const sys028 = (await client.hgetall("settings:system").catch(() => null)) as
        | Record<string, string>
        | null
      const haveSys028 = sys028 || {}

      const sysWrites028: Record<string, string> = {}
      const SYS_PINS_028: Record<string, string> = {
        live_sync_interval_ms:  "200",   // MUST stay 200 — do not raise
        live_sync_pause_ms:     "50",
      }
      for (const [k, v] of Object.entries(SYS_PINS_028)) {
        if (!haveSys028[k]) sysWrites028[k] = v
      }
      if (Object.keys(sysWrites028).length > 0) {
        await client.hset("settings:system", sysWrites028)
      }

      // ── 2. Seed minStep default (5) for all connections ──────────────────
      //
      // minStep (range 2-30, default 5) was added to the per-connection
      // strategy settings in the same session as this migration. Backfill
      // the default into connection_settings:{id} for every existing
      // connection so the engine reads the correct floor immediately without
      // requiring an operator save through the UI.
      //
      // Uses client.keys("connection:*") to enumerate connections — same
      // safe pattern as migrations v23/v26 (no getAllConnections deadlock risk).
      //
      // IDEMPOTENT: hgetall + conditional-hset, never clobbers operator values.
      let connKeys028: string[] = []
      try {
        const raw = await client.keys("connection:*")
        // Filter out sub-keys: only keep bare "connection:{id}" (no extra colons
        // beyond the first), e.g. "connection:bingx-x01", not
        // "connection:bingx-x01:settings".
        connKeys028 = (raw as string[]).filter((k: string) => {
          const parts = k.split(":")
          return parts.length === 2
        })
      } catch {
        connKeys028 = []
      }

      let seeded028 = 0
      for (const connKey of connKeys028) {
        const connId = connKey.split(":")[1]
        const settingsKey = `connection_settings:${connId}`
        const existing028 = (await client.hgetall(settingsKey).catch(() => null)) as
          | Record<string, string>
          | null
        const have028 = existing028 || {}
        if (!have028["minStep"]) {
          await client.hset(settingsKey, { minStep: "5" })
          seeded028++
        }
      }

      console.log(
        `[v0] Migration 028: pinned live_sync_interval_ms=200 in settings:system; ` +
        `seeded minStep=5 into ${seeded028}/${connKeys028.length} connection_settings hashes`,
      )
    },
    down: async (client: any) => {
      await client.set("_schema_version", "27")
    },
  },

  // ──────────────────────────────────────────────────────────────────────────
  // Migration 029 — Seed useMaximalLeverage + leveragePercentage into app_settings
  //
  // Prior to this migration:
  //   • all three seed locations (settings-storage, production-seeder,
  //     app/api/settings GET) defaulted `default_leverage: 10` and did not
  //     write `useMaximalLeverage` or `leveragePercentage` at all.
  //   • volume-calculator.ts had a comment "no longer consulted" and ignored
  //     these settings, always falling back to exchange-max.
  //   • The Settings UI had all three leverage controls locked/disabled.
  //
  // This migration:
  //   1. Sets `useMaximalLeverage=true` and `leveragePercentage=100` in the
  //      canonical `app_settings` hash (idempotent — skips if already set).
  //   2. Clears the stale `default_leverage=10` value from `app_settings`
  //      to avoid confusion (the engine never reads this field at order time).
  //   3. Seeds the same pair into every `connection_settings:{id}` hash that
  //      was not already written by migration 026.
  // ──────────────────────────────────────────────────────────────────────────
  {
    name: "029-leverage-policy-defaults-in-app-settings",
    version: 29,
    up: async (client: any) => {
      await client.set("_schema_version", "29")

      // 1. app_settings — seed leverage policy fields
      const appSettings029 = (await client.hgetall("app_settings").catch(() => null)) as
        | Record<string, string>
        | null
      const have029app = appSettings029 || {}
      const appWrites029: Record<string, string> = {}
      if (!have029app["useMaximalLeverage"]) appWrites029["useMaximalLeverage"] = "true"
      if (!have029app["leveragePercentage"])  appWrites029["leveragePercentage"]  = "100"
      // Remove the misleading legacy default_leverage=10 if it was never
      // operator-set to something meaningful (0 means "use predefinition").
      if (have029app["default_leverage"] === "10") appWrites029["default_leverage"] = "0"
      if (Object.keys(appWrites029).length > 0) {
        await client.hset("app_settings", appWrites029)
      }

      // 2. connection_settings hashes — seed per-connection defaults
      let connKeys029: string[] = []
      try {
        const raw = await client.smembers("connections")
        connKeys029 = (raw as string[]).filter((k: string) => typeof k === "string" && k.length > 0)
      } catch {
        connKeys029 = []
      }

      let seeded029 = 0
      for (const connId of connKeys029) {
        const settingsKey = `connection_settings:${connId}`
        const existing029 = (await client.hgetall(settingsKey).catch(() => null)) as
          | Record<string, string>
          | null
        const have029conn = existing029 || {}
        const writes029: Record<string, string> = {}
        if (!have029conn["useMaximalLeverage"]) writes029["useMaximalLeverage"] = "true"
        if (!have029conn["leveragePercentage"])  writes029["leveragePercentage"]  = "100"
        if (Object.keys(writes029).length > 0) {
          await client.hset(settingsKey, writes029)
          seeded029++
        }
      }

      console.log(
        `[v0] Migration 029: seeded useMaximalLeverage/leveragePercentage into app_settings` +
        ` and ${seeded029}/${connKeys029.length} connection_settings hashes`,
      )
    },
    down: async (client: any) => {
      await client.set("_schema_version", "28")
    },
  },
  {
    // ── v30: Seed coordination variant / axis / block defaults ──────────────
    // The strategy coordinator's `loadCoordinationSettings()` now reads from
    // `connection_settings:{id}` (per-connection hash) with fallback to global
    // `app_settings`. Existing hashes have no coordination fields, so the first
    // cycle after upgrade would fall back to global which may also be absent.
    // Seed spec defaults idempotently (never clobbers operator-set values):
    //   variants:  trailing=true, block=true, dca=false
    //   axes:      all disabled by default, including pause-axis; maxWindow seeded to spec defaults
    //   variants:  trailing=true, block=true, dca=false, pause=true
    //   axes:      all disabled by default, maxWindow seeded to spec defaults
    //   block knobs: blockVolumeRatio=1.0, blockMaxStack=10
    //
    // Also seeds app_settings so global fallback works the same way.
    name: "030-coordination-variant-axis-block-defaults",
    version: 30,
    up: async (client: any) => {
      await client.set("_schema_version", "30")

      const COORD_DEFAULTS: Record<string, string> = {
        // Variant toggles
        variantTrailingEnabled: "true",
        variantBlockEnabled:    "true",
        variantDcaEnabled:      "false",  // off by spec default
        variantPauseEnabled:    "true",
        // Axis toggles — disabled by default (operator must opt-in)
        axisPrevEnabled:   "false",
        axisPrevMaxWindow: "12",
        axisLastEnabled:   "false",
        axisLastMaxWindow: "4",
        axisContEnabled:   "false",
        axisContMaxWindow: "8",
        axisPauseEnabled:  "false",
        axisPauseMaxWindow: "8",
        // Block strategy tuning
        blockVolumeRatio: "1.0",
        blockMaxStack:    "10",
        blockPauseCountRatio: "1.0",
        blockActiveRealEnabled: "true",
        blockActiveLiveEnabled: "true",
      }

      // ── 1. app_settings global fallback ─────────────────────────────────
      const appS030 = (await client.hgetall("app_settings").catch(() => null)) as
        | Record<string, string>
        | null
      const haveApp030 = appS030 || {}
      const appWrites030: Record<string, string> = {}
      for (const [k, def] of Object.entries(COORD_DEFAULTS)) {
        if (!haveApp030[k]) appWrites030[k] = def
      }
      if (Object.keys(appWrites030).length > 0) {
        await client.hset("app_settings", appWrites030)
      }

      // ── 2. Per-connection hashes ─────────────────────────────────────────
      let connIds030: string[] = []
      try {
        const raw = await client.smembers("connections")
        connIds030 = (raw as string[]).filter(
          (k: string) => typeof k === "string" && k.length > 0,
        )
      } catch {
        connIds030 = []
      }

      let seeded030 = 0
      for (const connId of connIds030) {
        const hkey = `connection_settings:${connId}`
        const existing030 = (await client.hgetall(hkey).catch(() => null)) as
          | Record<string, string>
          | null
        const have030 = existing030 || {}
        const writes030: Record<string, string> = {}
        for (const [k, def] of Object.entries(COORD_DEFAULTS)) {
          // Never clobber a field the operator already set.
          if (!have030[k]) writes030[k] = def
        }
        if (Object.keys(writes030).length > 0) {
          await client.hset(hkey, writes030)
          seeded030++
        }
      }

      console.log(
        `[v0] Migration 030: seeded coordination defaults into app_settings` +
        ` and ${seeded030}/${connIds030.length} connection_settings hashes`,
      )
    },
    down: async (client: any) => {
      await client.set("_schema_version", "29")
    },
  },
  {
    // Migration 031 — Seed live-trade test configuration for bingx-x01
    //
    // Purpose: sets is_live_trade=1, five concrete test symbols (BTC/ETH/SOL/
    // BNB/XRP), and exchangePositionCost=0.02 (minimum volume) into BOTH the
    // connection hash and the connection_settings hash so the values survive
    // dev-mode HMR restarts that wipe the in-process Redis.
    //
    // Safety: every write is `set-if-absent` so an operator override made via
    // the UI (which writes the same hash fields) will never be clobbered on
    // the next boot. To reset to fresh test state: flush the DB via
    // /api/install/database/flush and restart.
    name: "031-bingx-x01-live-trade-test-defaults",
    version: 31,
    up: async (client: any) => {
      await client.set("_schema_version", "31")

      const TEST_SYMBOLS = ["BTCUSDT", "ETHUSDT", "SOLUSDT", "BNBUSDT", "XRPUSDT"]
      const TEST_SYMBOLS_JSON = JSON.stringify(TEST_SYMBOLS)

      const CONN_KEY     = "connection:bingx-x01"
      const SETTINGS_KEY = "connection_settings:bingx-x01"

      // ── 1. connection hash (what the engine reads for is_live_trade) ────────
      const existingConn = (await client.hgetall(CONN_KEY).catch(() => null)) as
        | Record<string, string> | null
      const haveConn = existingConn || {}
      const connWrites: Record<string, string> = {}
      // is_live_trade: only set if the operator has not already toggled it
      if (!haveConn["is_live_trade"] || haveConn["is_live_trade"] === "0" || haveConn["is_live_trade"] === "false") {
        connWrites["is_live_trade"] = "1"
      }
      // active_symbols: set if empty / absent
      const hasSymbols =
        typeof haveConn["active_symbols"] === "string" &&
        haveConn["active_symbols"].trim().length > 0 &&
        haveConn["active_symbols"] !== "[]"
      if (!hasSymbols) {
        connWrites["active_symbols"] = TEST_SYMBOLS_JSON
        connWrites["symbol_count"]   = String(TEST_SYMBOLS.length)
        // Default order: by exchange 1h volatility (seeded list is a static
        // fallback until the resolver fetches live ticker data).
        connWrites["symbol_order"]   = "volatility"
      }
      if (Object.keys(connWrites).length > 0) {
        await client.hset(CONN_KEY, connWrites)
      }

      // ── 2. connection_settings hash (what VolumeCalculator reads) ──────────
      const existingSettings = (await client.hgetall(SETTINGS_KEY).catch(() => null)) as
        | Record<string, string> | null
      const haveSettings = existingSettings || {}
      const settingsWrites: Record<string, string> = {}
      if (!haveSettings["exchangePositionCost"]) settingsWrites["exchangePositionCost"] = "0.02"
      if (!haveSettings["positions_average"])    settingsWrites["positions_average"]    = "2"
      if (Object.keys(settingsWrites).length > 0) {
        await client.hset(SETTINGS_KEY, settingsWrites)
      }

      // ── 3. setSettings-prefixed keys (what getSymbols() reads) ─────────────
      // getSymbols() resolves symbols via getSettings("trade_engine_state:{id}")
      // and getSettings("connection:{id}") which both add the "settings:" prefix.
      // The raw connection hash (CONN_KEY) is never seen by getSymbols(), so we
      // must also write active_symbols to these prefixed hashes.
      if (!hasSymbols) {
        await client.hset(`settings:trade_engine_state:bingx-x01`, {
          active_symbols: TEST_SYMBOLS_JSON,
          symbol_count: String(TEST_SYMBOLS.length),
          config_set_symbols_total: String(TEST_SYMBOLS.length),
        }).catch(() => {})
        await client.hset(`settings:connection:bingx-x01`, {
          active_symbols: TEST_SYMBOLS_JSON,
          symbol_count: String(TEST_SYMBOLS.length),
        }).catch(() => {})
      }

      console.log(
        `[v0] Migration 031: bingx-x01 live-trade test defaults seeded ` +
        `(is_live_trade=${connWrites["is_live_trade"] ?? "kept"}, ` +
        `symbols=${hasSymbols ? "kept" : TEST_SYMBOLS.join(",")}, ` +
        `exchangePositionCost=${settingsWrites["exchangePositionCost"] ?? "kept"})`,
      )
    },
    down: async (client: any) => {
      await client.set("_schema_version", "30")
    },
  },

  {
    // Version 032 was intentionally skipped — migration 033 superseded the
    // in-progress v32 draft before it was ever shipped. This tombstone fills
    // the version gap so:
    //   a) The `migrations.filter(m => m.version > currentVersion)` loop never
    //      skips v033 on a DB that somehow recorded _schema_version=32.
    //   b) migration 033's `down` can safely decrement to "32" and land on
    //      this no-op, then a second rollback step gets back to "31".
    name: "032-tombstone-skipped-version",
    version: 32,
    up: async (client: any) => {
      await client.set("_schema_version", "32")
      console.log("[v0] Migration 032: tombstone — version 32 was intentionally skipped (033 superseded in-progress draft)")
    },
    down: async (client: any) => {
      await client.set("_schema_version", "31")
    },
  },
  // Migration 033 — Expand bingx-x01 to 15 symbols + write force_symbols override
  // (supersedes v32 which lacked force_symbols; bumped so existing DBs re-run)
  {
    name: "033-bingx-x01-force-15-symbols",
    version: 33,
    up: async (client: any) => {
      await client.set("_schema_version", "33")

      const SYMBOLS_15 = [
        "BTCUSDT",  "ETHUSDT",  "SOLUSDT",  "BNBUSDT",  "XRPUSDT",
        "DOGEUSDT", "ADAUSDT",  "AVAXUSDT", "LINKUSDT", "DOTUSDT",
        "ATOMUSDT", "LTCUSDT",  "UNIUSDT",  "NEARUSDT", "MATICUSDT",
      ]
      const CONN_ID = "bingx-x01"
      const symJson = JSON.stringify(SYMBOLS_15)
      const symCount = String(SYMBOLS_15.length)
      // Write `force_symbols` — the highest-priority field in getSymbols().
      // Unlike `active_symbols` / `symbols`, `force_symbols` is NEVER written
      // by the engine startup path, so it cannot be silently overwritten when
      // the live BingX connection returns a different set (e.g. 12 exchange
      // symbols from the user's actual account).  getSymbols() checks this
      // field first and returns early, skipping all other fallbacks.
      await Promise.all([
        client.hset(`connection:${CONN_ID}`, {
          active_symbols: symJson,
          force_symbols:  symJson,
          symbol_count:   symCount,
          updated_at:     new Date().toISOString(),
        }),
        client.hset(`settings:trade_engine_state:${CONN_ID}`, {
          active_symbols:        symJson,
          force_symbols:         symJson,
          symbols:               symJson,
          symbol_count:          symCount,
          config_set_symbols_total: symCount,
        }),
        client.hset(`settings:connection:${CONN_ID}`, {
          active_symbols: symJson,
          force_symbols:  symJson,
          symbol_count:   symCount,
        }),
      ]).catch(() => {})
      console.log(`[v0] Migration 033: bingx-x01 force_symbols set to 15 symbols: ${SYMBOLS_15.join(",")}`)

      // Invalidate the running engine's symbol cache so the next cycle picks up
      // force_symbols immediately rather than waiting for the 5-second TTL.
      // Also update the progression snapshot so the status API reflects 15 symbols.
      try {
        const { getTradeEngine } = await import("@/lib/trade-engine")
        const coordinator = getTradeEngine()
        // invalidateSymbolsCacheForConnection is the public coordinator API;
        // fall back silently if the running engine doesn't expose it (non-critical
        // since the 5-second TTL will expire before the next cycle anyway).
        if (coordinator && typeof (coordinator as any).invalidateSymbolsCacheForConnection === "function") {
          ;(coordinator as any).invalidateSymbolsCacheForConnection(CONN_ID)
          console.log(`[v0] Migration 033: invalidated symbol cache on running engine`)
        }
      } catch { /* engine may not be running — safe to ignore */ }

      // Stamp a fresh progression snapshot so status API shows 15 symbols.
      await client.hset(`progression:${CONN_ID}`, {
        symbol_count:                 symCount,
        active_symbols_hash:          SYMBOLS_15.sort().join("|"),
        started_for_settings_version: new Date().toISOString(),
        progress_settings_snapshot:   JSON.stringify({
          symbol_count:      Number(symCount),
          symbols_hash:      SYMBOLS_15.sort().join("|"),
          is_live_trade:     "1",
          is_preset_trade:   "0",
          live_volume_factor: "1",
          connection_method: "library",
          updated_at:        new Date().toISOString(),
        }),
      }).catch(() => {})
    },
    down: async (client: any) => {
      // Roll back to 032 (the tombstone), which is a no-op one step from 031.
      await client.set("_schema_version", "32")
    },
  },
  // ── Migration 034 — operator-spec defaults ─────────────�������────────────────────
  // Seeds the operator-directed configuration defaults for bingx-x01:
  //   • live_volume_factor = 2.2  (written to BOTH connection:{id} and
  //     connection_settings:{id} so all three priority tiers in
  //     VolumeCalculator.resolveVolumeFactors() are satisfied; app_settings
  //     also gets volume_factor_live=2.2 as the global fallback)
  //   • baseProfitFactor=1.0, main/real/liveProfitFactor=1.2
  //     → written to connection_settings:bingx-x01 using the camelCase keys
  //       that StrategyCoordinator.loadProfitFactors() reads (NOT the
  //       pf_base_min snake_case names used by the old settings UI)
  //   • variantTrailingEnabled / variantBlockEnabled / variantDcaEnabled → written to connection_settings:bingx-x01
  //   • variantTrailingEnabled / variantBlockEnabled / variantDcaEnabled /
  //     variantPauseEnabled → written to connection_settings:bingx-x01
  //     using the camelCase keys that loadCoordinationSettings() reads
  //   • minStep=5, mainEvalPosCount=15, realEvalPosCount=10 →
  //     connection_settings:bingx-x01
  //   • symbol_order=volatility_1h written to connection:bingx-x01 (where
  //     getSymbols() resolves it)
  //
  // KEY INVARIANT: every field is written to the hash that the actual engine
  // code reads.  Previous incarnation of this migration wrote to
  // `settings:connection:bingx-x01` (a setSettings-prefixed key that only
  // the legacy settings-storage module reads) and used wrong field names
  // (snake_case variants that the coordinator never checks).  This version
  // targets the correct hashes with the correct names.
  //
  // IDEMPOTENT: values are written unconditionally (safe — migrations run
  // once per _schema_version level; operator overrides made after this
  // migration via the Settings UI are never touched by migrations).
  {
    version: 34,
    name: "034-operator-spec-defaults",
    up: async (client: any) => {
      await client.set("_schema_version", "34")

      const CONN_ID = "bingx-x01"
      const now = new Date().toISOString()

      // ── 1. app_settings — global volume factor fallback + PF thresholds ─────
      // VolumeCalculator priority-3 fallback reads `volume_factor_live` from here.
      // StrategyCoordinator reads baseProfitFactor/mainProfitFactor etc. from here
      // as the global default (then connection_settings overrides per-connection).
      await client.hset("app_settings", {
        volume_factor_live:   "2.2",   // global fallback for VolumeCalculator
        volume_factor_preset: "1.0",   // preset mode factor
        baseProfitFactor:     "1.0",   // coordinator global default
        mainProfitFactor:     "1.2",
        realProfitFactor:     "1.2",
        liveProfitFactor:     "1.2",
        updated_at:           now,
      }).catch(() => {})

      // ── 2. connection:bingx-x01 — direct connection hash ────────────────────
      // VolumeCalculator priority-1 reads `live_volume_factor` here.
      // getSymbols() reads `symbol_order` from here.
      await client.hset(`connection:${CONN_ID}`, {
        live_volume_factor:   "2.2",   // priority-1 override in VolumeCalculator
        preset_volume_factor: "1.0",
        symbol_order:         "volatility",
        updated_at:           now,
      }).catch(() => {})

      // ── 3. connection_settings:bingx-x01 — coordinator + volume overlay ─────
      // StrategyCoordinator.loadProfitFactors() and loadCoordinationSettings()
      // both read exclusively from `connection_settings:{id}` (hgetall).
      // VolumeCalculator priority-2 reads `live_volume_factor` here when the
      // caller passes the merged settings object.
      await client.hset(`connection_settings:${CONN_ID}`, {
        // Volume factors (VolumeCalculator priority-2)
        live_volume_factor:   "2.2",
        preset_volume_factor: "1.0",
        // PF thresholds — camelCase: what loadProfitFactors() reads
        baseProfitFactor:     "1.0",
        mainProfitFactor:     "1.2",
        realProfitFactor:     "1.2",
        liveProfitFactor:     "1.2",
        // Coordination variant toggles — camelCase: what loadCoordinationSettings() reads
        variantTrailingEnabled: "true",
        variantBlockEnabled:    "true",
        variantDcaEnabled:      "false",
        variantPauseEnabled:    "true",
        // Block knobs
        blockVolumeRatio:     "1.0",
        blockMaxStack:        "10",
        blockPauseCountRatio: "1.0",
        blockActiveRealEnabled: "true",
        blockActiveLiveEnabled: "true",
        // Eval thresholds
        mainEvalPosCount:     "3",
        realEvalPosCount:     "3",
        // Entry step
        minStep:              "5",
        updated_at:           now,
      }).catch(() => {})

      console.log("[v0] Migration 034: operator-spec defaults applied (pf=1.0/1.2/1.2, live_volume_factor=2.2, variantBlock/Trailing=true, correct hashes)")
    },
    down: async (client: any) => {
      await client.set("_schema_version", "33")
    },
  },

  // Migration 035 — Expand bingx-x01 to 20 symbols for intense retest
  // Adds 5 high-volume symbols on top of the 15 from migration 033.
  // Uses force_symbols (highest-priority field in getSymbols()) so the engine
  // cannot silently overwrite the list during startup symbol resolution.
  {
    name: "035-bingx-x01-force-20-symbols",
    version: 35,
    up: async (client: any) => {
      await client.set("_schema_version", "35")

      const SYMBOLS_20 = [
        "BTCUSDT",  "ETHUSDT",  "SOLUSDT",  "BNBUSDT",  "XRPUSDT",
        "DOGEUSDT", "ADAUSDT",  "AVAXUSDT", "LINKUSDT", "DOTUSDT",
        "ATOMUSDT", "LTCUSDT",  "UNIUSDT",  "NEARUSDT", "MATICUSDT",
        "AAVEUSDT", "SUIUSDT",  "APTUSDT",  "ARBUSDT",  "OPUSDT",
      ]
      const CONN_ID = "bingx-x01"
      const symJson = JSON.stringify(SYMBOLS_20)
      const symCount = String(SYMBOLS_20.length)

      await Promise.all([
        client.hset(`connection:${CONN_ID}`, {
          active_symbols: symJson,
          force_symbols:  symJson,
          symbol_count:   symCount,
          updated_at:     new Date().toISOString(),
        }),
        client.hset(`settings:trade_engine_state:${CONN_ID}`, {
          active_symbols:           symJson,
          force_symbols:            symJson,
          symbols:                  symJson,
          symbol_count:             symCount,
          config_set_symbols_total: symCount,
        }),
        client.hset(`settings:connection:${CONN_ID}`, {
          active_symbols: symJson,
          force_symbols:  symJson,
          symbol_count:   symCount,
        }),
      ]).catch(() => {})
      console.log(`[v0] Migration 035: bingx-x01 force_symbols set to 20 symbols: ${SYMBOLS_20.join(",")}`)

      // Invalidate running engine's symbol cache immediately.
      try {
        const { getTradeEngine } = await import("@/lib/trade-engine")
        const coordinator = getTradeEngine()
        if (coordinator && typeof (coordinator as any).invalidateSymbolsCacheForConnection === "function") {
          ;(coordinator as any).invalidateSymbolsCacheForConnection(CONN_ID)
          console.log(`[v0] Migration 035: invalidated symbol cache on running engine`)
        }
      } catch { /* engine may not be running — safe to ignore */ }

      // Stamp a fresh progression snapshot so the status API reflects 20 symbols.
      await client.hset(`progression:${CONN_ID}`, {
        symbol_count:                 symCount,
        active_symbols_hash:          SYMBOLS_20.slice().sort().join("|"),
        started_for_settings_version: new Date().toISOString(),
        progress_settings_snapshot:   JSON.stringify({
          symbol_count:      Number(symCount),
          symbols_hash:      SYMBOLS_20.slice().sort().join("|"),
          is_live_trade:     "0",
          is_preset_trade:   "0",
          live_volume_factor: "1",
          connection_method: "library",
          updated_at:        new Date().toISOString(),
        }),
      }).catch(() => {})
    },
    down: async (client: any) => {
      await client.set("_schema_version", "34")
    },
  },

  // Migration 036 — Make bingx-x01 visible in the Active panel from first boot
  // Previous seed set is_active_inserted="0" so the connections route showed
  // "Inserted (visible): none" and system-stats showed exchangeConnections=0.
  // Patch is_active_inserted="1" on any existing bingx-x01 row that has it unset.
  {
    name: "036-bingx-x01-active-inserted",
    version: 36,
    up: async (client: any) => {
      await client.set("_schema_version", "36")
      const CONN_ID = "bingx-x01"
      const existing = await client.hgetall(`connection:${CONN_ID}`).catch(() => null)
      if (existing && typeof existing === "object") {
        const patch: Record<string, string> = { updated_at: new Date().toISOString() }
        // Only patch if not already set — preserve operator overrides.
        if (!existing["is_active_inserted"] || existing["is_active_inserted"] === "0" || existing["is_active_inserted"] === "false") {
          patch["is_active_inserted"] = "1"
        }
        if (!existing["is_dashboard_inserted"] || existing["is_dashboard_inserted"] === "0" || existing["is_dashboard_inserted"] === "false") {
          patch["is_dashboard_inserted"] = "1"
        }
        if (Object.keys(patch).length > 1) {
          await client.hset(`connection:${CONN_ID}`, patch)
          console.log(`[v0] Migration 036: patched ${CONN_ID} is_active_inserted=1`)
        } else {
          console.log(`[v0] Migration 036: ${CONN_ID} is_active_inserted already set, no patch needed`)
        }
      }
    },
    down: async (client: any) => {
      await client.set("_schema_version", "35")
    },
  },
  {
    // Migration 037 — seed is_enabled_dashboard=1 for bingx-x01.
    //
    // ROOT CAUSE of "Enabled dashboard: none" diagnostic log:
    //   Migration 036 sets is_active_inserted=1 but never sets
    //   is_enabled_dashboard. The key is absent → parseHashValue returns null
    //   → isEnabledFlag(null)=false → connections route prints "none".
    //   The start route only writes is_enabled_dashboard=1 AFTER the engine
    //   starts (post-boot), so every request fired before the first engine
    //   start showed 0. This migration seeds the flag so it is "1" from the
    //   very first boot, even before any engine ever starts.
    //
    // STANDING DIRECTIVE COMPLIANCE: Seeding is_enabled_dashboard=1 does NOT
    //   auto-start the engine. The engine only starts when the operator
    //   explicitly calls POST /api/trade-engine/start (or the dashboard Start
    //   button). The flag is only a dashboard-display toggle; it gates live-
    //   trade and preset operations but does NOT trigger startMissingEngines
    //   by itself (auto-start was eliminated in ea6ec91).
    name: "037-bingx-x01-enabled-dashboard",
    version: 37,
    up: async (client: any) => {
      await client.set("_schema_version", "37")
      const CONN_ID = "bingx-x01"
      const existing = await client.hgetall(`connection:${CONN_ID}`).catch(() => null)
      if (existing && typeof existing === "object") {
        const patch: Record<string, string> = { updated_at: new Date().toISOString() }
        // Only set if the flag is absent or explicitly "0". Preserve "1".
        const cur = existing["is_enabled_dashboard"]
        if (!cur || cur === "0" || cur === "false") {
          patch["is_enabled_dashboard"] = "1"
        }
        if (Object.keys(patch).length > 1) {
          await client.hset(`connection:${CONN_ID}`, patch)
          console.log(`[v0] Migration 037: seeded ${CONN_ID} is_enabled_dashboard=1`)
        } else {
          console.log(`[v0] Migration 037: ${CONN_ID} is_enabled_dashboard already "1", no patch needed`)
        }
      } else {
        console.log(`[v0] Migration 037: ${CONN_ID} not found — skipping`)
      }
    },
    down: async (client: any) => {
      await client.set("_schema_version", "36")
    },
  },

  {
    version: 38,
    name: "038-maticusdt-to-polusdt",
    description: "Replace delisted MATICUSDT with POLUSDT in bingx-x01 force_symbols",
    up: async (client: any) => {
      const CONN_ID = "bingx-x01"

      // getSymbols() calls getSettings("trade_engine_state:{id}") and
      // getSettings("connection:{id}") — getSettings() prepends "settings:"
      // so the actual Redis keys are "settings:trade_engine_state:{id}" and
      // "settings:connection:{id}".  We must write force_symbols to those
      // prefixed hashes, NOT to the raw "connection:{id}" hash, for the
      // engine to pick it up without a restart.
      const PREFIXED_STATE  = `settings:trade_engine_state:${CONN_ID}`
      const PREFIXED_CONN   = `settings:connection:${CONN_ID}`
      const RAW_CONN        = `connection:${CONN_ID}`

      // Read current force_symbols from the prefixed state hash first
      // (highest priority in getSymbols), then fall back to the raw conn hash.
      const [stateHash, connHash] = await Promise.all([
        client.hgetall(PREFIXED_STATE).catch(() => null),
        client.hgetall(RAW_CONN).catch(() => null),
      ])

      const parseSyms = (raw: string | null | undefined): string[] => {
        if (!raw) return []
        try { const arr = JSON.parse(raw); return Array.isArray(arr) ? arr : [] } catch { /* ignore */ }
        return raw.split(",").map((s: string) => s.trim()).filter(Boolean)
      }

      // Determine current symbol list: prefer what the engine will actually read.
      const existingForce  = parseSyms((stateHash as any)?.force_symbols)
      const existingActive = parseSyms((stateHash as any)?.active_symbols)
      const rawConnSyms    = parseSyms((connHash as any)?.force_symbols || (connHash as any)?.active_symbols)

      let syms = existingForce.length ? existingForce
               : existingActive.length ? existingActive
               : rawConnSyms.length ? rawConnSyms
               : [...BASE_TEST_SYMBOLS]          // fresh DB — seed canonical list

      const hadMatic = syms.includes("MATICUSDT")
      syms = syms.map((s) => (s === "MATICUSDT" ? "POLUSDT" : s))

      const symJson = JSON.stringify(syms)

      // Write to all three hashes so nothing is stale regardless of read path.
      await Promise.all([
        client.hset(PREFIXED_STATE, { force_symbols: symJson, symbol_count: String(syms.length) }),
        client.hset(PREFIXED_CONN,  { force_symbols: symJson, symbol_count: String(syms.length) }),
        client.hset(RAW_CONN,       { force_symbols: symJson, symbol_count: String(syms.length) }),
      ])

      console.log(
        `[v0] Migration 038: ${CONN_ID} force_symbols updated ` +
        `(MATICUSDT→POLUSDT: ${hadMatic}): ${syms.join(",")}`,
      )
    },
    down: async (client: any) => {
      await client.set("_schema_version", "37")
    },
  },

  {
    // Migration 038 was shipped with a bug — it wrote force_symbols to the raw
    // "connection:{id}" hash instead of the "settings:*" prefixed hashes that
    // getSymbols() actually reads.  Migration 039 re-applies the correct write
    // regardless of whether 038 ran.
    version: 39,
    name: "039-polusdt-settings-hashes",
    // ↑ keep 038/039 as-is for existing DBs that already ran them
    description: "Re-apply POLUSDT force_symbols to settings: prefixed hashes (fixes 038 write-path bug)",
    up: async (client: any) => {
      const CONN_ID = "bingx-x01"
      const PREFIXED_STATE = `settings:trade_engine_state:${CONN_ID}`
      const PREFIXED_CONN  = `settings:connection:${CONN_ID}`
      const RAW_CONN       = `connection:${CONN_ID}`

      const parseSyms = (raw: string | null | undefined): string[] => {
        if (!raw) return []
        try { const arr = JSON.parse(raw); return Array.isArray(arr) ? arr : [] } catch { /* ignore */ }
        return raw.split(",").map((s: string) => s.trim()).filter(Boolean)
      }

      const [stateHash, connHash] = await Promise.all([
        client.hgetall(PREFIXED_STATE).catch(() => null),
        client.hgetall(RAW_CONN).catch(() => null),
      ])

      const existing = parseSyms((stateHash as any)?.force_symbols)
        .concat(parseSyms((stateHash as any)?.active_symbols))
        .concat(parseSyms((connHash as any)?.force_symbols || (connHash as any)?.active_symbols))

      // Use first non-empty list found; fall back to canonical 20-symbol list.
      const found = [
        parseSyms((stateHash as any)?.force_symbols),
        parseSyms((stateHash as any)?.active_symbols),
        parseSyms((connHash as any)?.force_symbols),
        parseSyms((connHash as any)?.active_symbols),
        [...BASE_TEST_SYMBOLS],
      ].find((arr) => arr.length > 0) ?? [...BASE_TEST_SYMBOLS]

      void existing  // suppress unused warning

      const syms = found.map((s) => (s === "MATICUSDT" ? "POLUSDT" : s))
      const symJson = JSON.stringify(syms)

      await Promise.all([
        client.hset(PREFIXED_STATE, { force_symbols: symJson, symbol_count: String(syms.length) }),
        client.hset(PREFIXED_CONN,  { force_symbols: symJson, symbol_count: String(syms.length) }),
        client.hset(RAW_CONN,       { force_symbols: symJson, symbol_count: String(syms.length) }),
      ])

      console.log(
        `[v0] Migration 039: force_symbols written to settings: hashes — ${syms.join(",")}`,
      )
    },
    down: async (client: any) => {
      await client.set("_schema_version", "38")
    },
  },

  // ── Migration 040 — Canonical bingx-x01 state (supersedes 033-039) ────────
  //
  // Consolidates what migrations 033 (15 symbols), 034 (operator defaults),
  // 035 (20 symbols), 036 (trailing/enabled tweaks), 037 (is_enabled_dashboard),
  // 038 (MATICUSDT→POLUSDT), and 039 (fix 038 write-path) each patched in
  // isolation.  This migration applies the FULL desired canonical state in one
  // atomic pass so fresh DBs and existing DBs (already at version 39) both
  // land in the same known-good configuration:
  //
  //   • 20 symbols with POLUSDT (not MATICUSDT) written to all three hashes
  //   • Operator-spec volume/PF/variant defaults in app_settings +
  //     connection:bingx-x01 + connection_settings:bingx-x01
  //   • symbol_order = volatility in connection:bingx-x01
  //   • Fresh progression snapshot so status API reflects 20 symbols
  //   • symbol cache invalidated on running engine
  //
  // KEY INVARIANT: every field is written to the hash the engine code actually
  // reads.  See migration 034 comments for the full field-name / hash-key matrix.
  {
    version: 40,
    name: "040-canonical-bingx-x01-state",
    up: async (client: any) => {
      // NOTE: do NOT stamp _schema_version here. The runner stamps it only after
      // up() resolves successfully. Stamping at the start meant a mid-migration
      // crash falsely marked the migration complete, so it never re-ran.
      const CONN_ID = "bingx-x01"
      const now     = new Date().toISOString()

      // The authoritative canonical 20-symbol list (shared constant, POLUSDT not MATICUSDT)
      const SYMS = [...BASE_TEST_SYMBOLS]   // ["BTCUSDT", ..., "POLUSDT", ..., "OPUSDT"]
      const symJson  = JSON.stringify(SYMS)
      const symCount = String(SYMS.length)

      // ── 1. Write force_symbols to ALL three hashes (set-if-absent for symbols) ──
      // getSymbols() priority: settings:trade_engine_state > settings:connection > connection.
      // Symbol fields use set-if-absent (hsetnx equivalent) so operator PATCHes
      // (e.g. reducing to 15 symbols for testing) survive a subsequent restart.
      // Non-symbol fields (volume, order, timestamps) are always written.
      const engExisting  = (await client.hgetall(`settings:trade_engine_state:${CONN_ID}`).catch(() => null)) as Record<string,string>|null ?? {}
      const connExisting = (await client.hgetall(`connection:${CONN_ID}`).catch(() => null)) as Record<string,string>|null ?? {}

      const engSymWrites: Record<string,string> = {}
      if (!engExisting["force_symbols"]  || engExisting["force_symbols"]  === "[]") engSymWrites["force_symbols"]  = symJson
      if (!engExisting["active_symbols"] || engExisting["active_symbols"] === "[]") engSymWrites["active_symbols"] = symJson
      if (!engExisting["symbols"]        || engExisting["symbols"]        === "[]") engSymWrites["symbols"]        = symJson
      if (!engExisting["symbol_count"]   || engExisting["symbol_count"]   === "0")  engSymWrites["symbol_count"]   = symCount
      if (!engExisting["config_set_symbols_total"]) engSymWrites["config_set_symbols_total"] = symCount

      const connSymWrites: Record<string,string> = {}
      if (!connExisting["force_symbols"]  || connExisting["force_symbols"]  === "[]") connSymWrites["force_symbols"]  = symJson
      if (!connExisting["active_symbols"] || connExisting["active_symbols"] === "[]") connSymWrites["active_symbols"] = symJson
      if (!connExisting["symbol_count"]   || connExisting["symbol_count"]   === "0")  connSymWrites["symbol_count"]   = symCount

      await Promise.all([
        Object.keys(engSymWrites).length  > 0 ? client.hset(`settings:trade_engine_state:${CONN_ID}`, engSymWrites).catch(() => {}) : Promise.resolve(),
        Object.keys(connSymWrites).length > 0 ? client.hset(`settings:connection:${CONN_ID}`, connSymWrites).catch(() => {})        : Promise.resolve(),
        // Always write non-symbol fields to connection hash (volume, order, timestamp)
        client.hset(`connection:${CONN_ID}`, {
          ...(Object.keys(connSymWrites).length > 0 ? connSymWrites : {}),
          live_volume_factor:   "2.2",
          preset_volume_factor: "1.0",
          symbol_order:         "volatility",
          updated_at:           now,
        }).catch(() => {}),
      ])

      // ── 2. app_settings — global PF thresholds + volume fallback ─────────
      await client.hset("app_settings", {
        volume_factor_live:   "2.2",
        volume_factor_preset: "1.0",
        baseProfitFactor:     "1.0",
        mainProfitFactor:     "1.2",
        realProfitFactor:     "1.2",
        liveProfitFactor:     "1.2",
        updated_at:           now,
      }).catch(() => {})

      // ── 3. connection_settings:bingx-x01 — coordinator + volume overlay ──
      // StrategyCoordinator.loadProfitFactors() + loadCoordinationSettings()
      // both read exclusively from connection_settings:{id} (hgetall).
      await client.hset(`connection_settings:${CONN_ID}`, {
        live_volume_factor:     "2.2",
        preset_volume_factor:   "1.0",
        baseProfitFactor:       "1.0",
        mainProfitFactor:       "1.2",
        realProfitFactor:       "1.2",
        liveProfitFactor:       "1.2",
        variantTrailingEnabled: "true",
        variantBlockEnabled:    "true",
        variantDcaEnabled:      "false",
        variantPauseEnabled:    "true",
        blockVolumeRatio:       "1.0",
        blockMaxStack:          "10",
        blockPauseCountRatio: "1.0",
        blockActiveRealEnabled: "true",
        blockActiveLiveEnabled: "true",
        mainEvalPosCount:       "3",
        realEvalPosCount:       "3",
        minStep:                "5",
        updated_at:             now,
      }).catch(() => {})

      // ── 4. Progression snapshot so status API reflects 20 symbols ─────────
      await client.hset(`progression:${CONN_ID}`, {
        symbol_count:                 symCount,
        active_symbols_hash:          SYMS.slice().sort().join("|"),
        started_for_settings_version: now,
        progress_settings_snapshot:   JSON.stringify({
          symbol_count:       Number(symCount),
          symbols_hash:       SYMS.slice().sort().join("|"),
          is_live_trade:      "1",
          is_preset_trade:    "0",
          live_volume_factor: "2.2",
          connection_method:  "library",
          updated_at:         now,
        }),
      }).catch(() => {})

      // ── 5. Invalidate running engine's symbol cache ────────────────────────
      try {
        const { getTradeEngine } = await import("@/lib/trade-engine")
        const coordinator = getTradeEngine()
        if (coordinator && typeof (coordinator as any).invalidateSymbolsCacheForConnection === "function") {
          ;(coordinator as any).invalidateSymbolsCacheForConnection(CONN_ID)
        }
      } catch { /* engine may not be running */ }

      console.log(
        `[v0] Migration 040: canonical bingx-x01 state applied — ` +
        `${SYMS.length} symbols (POLUSDT), pf=1.0/1.2/1.2, live_volume_factor=2.2`
      )
    },
    down: async (client: any) => {
      await client.set("_schema_version", "39")
    },
  },

  // ── Migration 041 ──────────────────────────────────────────────────────────
  // Repair legacy live_volume_factor values on connection:bingx-x01 and clear
  // the prehistoric_loaded:bingx-x01 cache gate that prevents re-runs when the
  // DB is wiped but the marker survives.
  //
  // Problem 1 — legacy liveVolumeFactor defaults in stats:
  //   Older migrations and write paths disagreed on the volume-factor default:
  //   some wrote operator-spec values (2.2/1.0), some wrote boolean/non-numeric
  //   placeholders, and newer minimal-default policy uses 0.1. Migration 042
  //   now supersedes this connection-specific repair and normalizes only
  //   missing/legacy-default values to the minimal default while preserving
  //   user-configured factors that differ from those defaults.
  //
  // Problem 2 — prehistoric re-run gate:
  //   `prehistoric_loaded:{conn}` (plain string "1") is the 24-hour cache key
  //   engine-manager uses to skip the ConfigSetProcessor pass. If it survives a
  //   sandbox reset / full DB wipe, the engine advances straight to live_trading
  //   with 0 pi_history keys → createBaseSets returns 0 → no strategy sets
  //   ever build → B=0 M=0 R=0 L=0 in stats forever. Delete it here so the
  //   migration always forces a fresh prehistoric run on the next engine boot.
  {
    version: 41,
    name: "041-fix-volume-and-prehistoric-gate",
    description: "Correct live_volume_factor to 2.2 and clear prehistoric_loaded gate for fresh prehistoric run",
    up: async (client: any) => {
      // NOTE: do NOT stamp _schema_version here — the runner stamps on success only.
      const CONN_ID = "bingx-x01"
      const now = new Date().toISOString()

      // 1. Historical repair retained for already-versioned DBs. Migration 042
      //    runs immediately after this one and supersedes the old 2.2/1.0
      //    defaults with the current minimal 0.1 policy.
      await client.hset(`connection:${CONN_ID}`, {
        live_volume_factor:   "2.2",
        preset_volume_factor: "1.0",
        updated_at:           now,
      }).catch(() => {})
      console.log(`[v0] Migration 041: set live_volume_factor=2.2 on connection:${CONN_ID}`)

      // 2. Clear prehistoric_loaded cache gate — forces fresh prehistoric on
      //    next engine boot. This is idempotent: engine re-stamps it after a
      //    successful prehistoric run so subsequent hot-reloads within the same
      //    session skip preprocessing correctly (as intended).
      await client.del(`prehistoric_loaded:${CONN_ID}`).catch(() => {})
      await client.del(`prehistoric_loaded:${CONN_ID}:verified`).catch(() => {})

      // 3. Clear the prehistoric:progress:{conn} tracker so the UI progress bar
      //    resets cleanly for the new session.
      await client.del(`prehistoric:progress:${CONN_ID}`).catch(() => {})

      console.log(`[v0] Migration 041: cleared prehistoric_loaded gate + progress tracker for ${CONN_ID}`)
    },
    down: async (client: any) => {
      await client.set("_schema_version", "40")
    },
  },
  {
    // Supersedes the earlier operator-spec migrations that seeded 2.2/1.0
    // volume-factor defaults (notably 034, 040, and the connection-specific
    // repair in 041). Running after them guarantees fresh and upgraded Redis
    // stores converge on the minimal-default policy.
    version: 42,
    name: "042-minimal-volume-factor-defaults",
    description: "Normalize legacy/default volume factors to the minimal 0.1 policy without clobbering explicit user values",
    up: async (client: any) => {
      // NOTE: do NOT stamp _schema_version here — the runner stamps on success only.
      const now = new Date().toISOString()
      const VOLUME_FACTOR_FIELDS = [
        "volume_factor",
        "live_volume_factor",
        "preset_volume_factor",
        "volume_factor_live",
        "volume_factor_preset",
      ]

      // Values that came from historical defaults rather than a distinguishable
      // user choice. Anything outside this set is treated as explicit operator
      // configuration and is left untouched.
      const LEGACY_DEFAULT_VALUES = new Set(["", "true", "false", "1", "1.0", "2.2"])

      const shouldNormalizeVolumeFactor = (value: unknown): boolean => {
        if (value === undefined || value === null) return true
        if (typeof value === "number") return value === 1 || value === 2.2 || !Number.isFinite(value)
        const normalized = String(value).trim().toLowerCase()
        if (LEGACY_DEFAULT_VALUES.has(normalized)) return true
        const numeric = Number(normalized)
        return Number.isFinite(numeric) && (numeric === 1 || numeric === 2.2)
      }

      const valueForRecord = (hash: Record<string, unknown>): string | number => {
        // Redis hashes are normally string-valued, but the inline/local emulator
        // can preserve numbers. If this record already stores any volume-factor
        // field as a number, keep that format for the normalized default.
        return VOLUME_FACTOR_FIELDS.some((field) => typeof hash[field] === "number") ? 0.1 : "0.1"
      }

      const keySet = new Set<string>(["app_settings"])
      for (const pattern of [
        "connection:*",
        "connection_settings:*",
        "settings:connection:*",
        "settings:trade_engine_state:*",
      ]) {
        try {
          const keys = (await client.keys(pattern)) || []
          for (const key of keys) {
            if (typeof key !== "string" || !key) continue
            keySet.add(key)
          }
        } catch { /* keys() unavailable — keep the sources collected so far */ }
      }

      let recordsTouched = 0
      let fieldsNormalized = 0
      for (const key of keySet) {
        const hash = (await client.hgetall(key).catch(() => null)) as Record<string, unknown> | null
        if (!hash || typeof hash !== "object") continue

        const minimalDefault = valueForRecord(hash)
        const patch: Record<string, string | number> = {}
        for (const field of VOLUME_FACTOR_FIELDS) {
          if (shouldNormalizeVolumeFactor(hash[field])) patch[field] = minimalDefault
        }

        if (Object.keys(patch).length > 0) {
          patch.updated_at = now
          await client.hset(key, patch).catch(() => {})
          recordsTouched++
          fieldsNormalized += Object.keys(patch).length - 1
        }
      }

      console.log(
        `[v0] Migration 042: normalized ${fieldsNormalized} legacy/default volume-factor fields ` +
        `across ${recordsTouched} connection/settings records to 0.1`,
      )
    },
    down: async (client: any) => {
      await client.set("_schema_version", "41")
    },
  },

  {
    version: 43,
    name: "043-reserved-schema-continuity",
    description: "No-op continuity marker preserving sequential schema upgrades",
    up: async (_client: any) => {
      console.log("[v0] Migration 043: no-op schema continuity marker")
    },
    down: async (client: any) => {
      await client.set("_schema_version", "42")
    },
  },
  {
    version: 44,
    name: "044-reserved-schema-continuity",
    description: "No-op continuity marker preserving sequential schema upgrades before connection cache rebuild",
    up: async (_client: any) => {
      console.log("[v0] Migration 044: no-op schema continuity marker")
    },
    down: async (client: any) => {
      await client.set("_schema_version", "43")
    },
  },

  // ── Migration 045 ──────────────────────────────────────────────────────────
  // Rebuild the connection list cache from canonical connection hashes without
  // clobbering live operator state or progressions.
  {
    version: 45,
    name: "045-rebuild-connection-list-cache",
    description: "Rebuild all_connections from canonical connection hashes without clobbering operator state",
    up: async (client: any) => {
      // NOTE: do NOT stamp _schema_version here — the runner stamps on success only.
      const connectionKeys = ((await client.keys("connection:*").catch(() => [])) || [])
        .filter((key: string) =>
          typeof key === "string" &&
          !key.includes(":settings:") &&
          !key.includes(":stats:") &&
          !key.includes(":logs:")
        )

      const rows: Record<string, unknown>[] = []
      for (const key of connectionKeys) {
        const row = (await client.hgetall(key).catch(() => null)) as Record<string, unknown> | null
        if (!row || Object.keys(row).length === 0) continue
        const id = String(row.id || key.replace(/^connection:/, ""))
        rows.push({ ...row, id })
        await client.sadd("connections", id).catch(() => {})
      }

      if (rows.length > 0) {
        await client.set("all_connections", JSON.stringify(rows))
      }

      console.log(`[v0] Migration 045: rebuilt all_connections from ${rows.length} connection hashes`)
    },
    down: async (client: any) => {
      await client.set("_schema_version", "44")
    },
  },
  {
    version: 46,
    name: "046-volume-step-ratio-defaults",
    description: "Seed volume step ratio defaults for stable balance-threshold sizing",
    up: async (client: any) => {
      const DEFAULT_STEP = "0.6"
      const app = ((await client.hgetall("app_settings").catch(() => ({}))) || {}) as Record<string, unknown>
      const legacy = ((await client.hgetall("all_settings").catch(() => ({}))) || {}) as Record<string, unknown>
      if (app.volume_step_ratio === undefined || app.volume_step_ratio === null || app.volume_step_ratio === "") {
        await client.hset("app_settings", { volume_step_ratio: DEFAULT_STEP })
      }
      if (legacy.volume_step_ratio === undefined || legacy.volume_step_ratio === null || legacy.volume_step_ratio === "") {
        await client.hset("all_settings", { volume_step_ratio: DEFAULT_STEP })
      }

      const connectionKeys = ((await client.keys("connection:*").catch(() => [])) || [])
        .filter((key: string) => typeof key === "string" && key.startsWith("connection:") && key.indexOf(":", "connection:".length) === -1)
      for (const key of connectionKeys) {
        const row = ((await client.hgetall(key).catch(() => ({}))) || {}) as Record<string, unknown>
        if (row.volume_step_ratio === undefined || row.volume_step_ratio === null || row.volume_step_ratio === "") {
          await client.hset(key, { volume_step_ratio: DEFAULT_STEP })
        }
        const id = String(row.id || key.replace(/^connection:/, ""))
        const settingsKey = `connection_settings:${id}`
        const settings = ((await client.hgetall(settingsKey).catch(() => ({}))) || {}) as Record<string, unknown>
        if (settings.volume_step_ratio === undefined || settings.volume_step_ratio === null || settings.volume_step_ratio === "") {
          await client.hset(settingsKey, { volume_step_ratio: DEFAULT_STEP })
        }
      }

      console.log("[v0] Migration 046: seeded volume_step_ratio=0.6 defaults")
    },
    down: async (client: any) => {
      await client.set("_schema_version", "45")
    },
  },
  {
    version: 47,
    name: "047-clear-stale-engine-restart-flags",
    description: "Remove legacy settings-save restart flags so running engines stay hot-reloadable",
    up: async (client: any) => {
      const stateKeys = [
        ...(((await client.keys("settings:trade_engine_state:*").catch(() => [])) || []) as string[]),
        ...(((await client.keys("trade_engine_state:*").catch(() => [])) || []) as string[]),
      ]
      let cleaned = 0
      for (const key of new Set(stateKeys)) {
        const removed = await client
          .hdel(key, "restart_required", "restart_reason", "restart_requested_at")
          .catch(() => 0)
        if (Number(removed) > 0) cleaned++
      }
      console.log(`[v0] Migration 047: cleared stale restart flags from ${cleaned} trade-engine state hashes`)
    },
    down: async (client: any) => {
      await client.set("_schema_version", "46")
    },
  },
  {
    version: 48,
    name: "048-clear-stale-engine-reload-flags",
    description: "Remove orphaned reload flags left after older dev/settings saves consumed their change events",
    up: async (client: any) => {
      const stateKeys = [
        ...(((await client.keys("settings:trade_engine_state:*").catch(() => [])) || []) as string[]),
        ...(((await client.keys("trade_engine_state:*").catch(() => [])) || []) as string[]),
      ]
      let cleaned = 0
      for (const key of new Set(stateKeys)) {
        const connectionId = key.split(":").pop()
        const pending = connectionId
          ? await client.hgetall(`settings:settings_change:${connectionId}`).catch(() => ({}))
          : {}
        if (pending && typeof pending.connectionId === "string" && pending.connectionId.length > 0) continue
        const removed = await client
          .hdel(key, "reload_required", "reload_fields", "reload_requested_at")
          .catch(() => 0)
        if (Number(removed) > 0) cleaned++
      }
      console.log(`[v0] Migration 048: cleared orphaned reload flags from ${cleaned} trade-engine state hashes`)
    },
    down: async (client: any) => {
      await client.set("_schema_version", "47")
    },
  },
  {
    // Strip progression:, settings:trade_engine_state:, settings:connection_settings:,
    // settings:eval_knobs:, and market_data: hashes from template-only connections.
    // These 9 connections (bybit-x03, binance-x01, okx-x01, ...) are shown in the
    // connection picker UI but never run the engine — they accumulate ~2 MB of
    // unnecessary migration-seeded hashes that inflate the InlineLocalRedis in-process
    // store and push boot RSS past the kernel OOM limit on the 4 GB v0 sandbox VM.
    // The connection: hash is PRESERVED so the UI still lists them as options.
    version: 49,
    name: "049-strip-template-connection-overhead",
    up: async (client: any) => {
      const ACTIVE_CONN = "bingx-x01"
      const templateIds = [
        "bybit-x03", "binance-x01", "okx-x01", "gateio-x01", "kucoin-x01",
        "mexc-x01", "bitget-x01", "pionex-x01", "orangex-x01", "huobi-x01",
      ]
      const prefixes = [
        "progression",
        "settings:trade_engine_state",
        "settings:connection_settings",
        "settings:eval_knobs",
        "prehistoric_loaded",
        "prehistoric:progress",
      ]
      let deleted = 0
      for (const id of templateIds) {
        if (id === ACTIVE_CONN) continue
        for (const prefix of prefixes) {
          const key = `${prefix}:${id}`
          const r = await client.del(key).catch(() => 0)
          if (Number(r) > 0) deleted++
        }
      }
      console.log(`[v0] Migration 049: stripped ${deleted} overhead keys from ${templateIds.length} template connections`)
    },
    down: async (client: any) => {
      await client.set("_schema_version", "48")
    },
  },
  {
    // Reduce bingx-x01 dev symbol set to 3 symbols so the engine can complete
    // prehistoric + realtime within the 913 MB of available RAM on the 4 GB
    // v0 sandbox VM (next-server itself occupies ~1870 MB RSS at idle).
    // 3 symbols × MAIN_AXIS_SETS_CEILING(1500) = 4500 axis sets peak vs
    // 20 symbols × 1500 = 30,000 — a 6.7× reduction in peak allocation.
    // Trade history correctness (exit prices, liveOpen key-scan) is fully
    // verifiable with 3 symbols; restore to 20 for production.
    version: 50,
    name: "050-3-symbol-mode",
    up: async (client: any) => {
      const DEV_SYMBOLS = "BTCUSDT,ETHUSDT,SOLUSDT"
      const connId = "bingx-x01"
      await client.hset(`connection:${connId}`, { force_symbols: DEV_SYMBOLS, symbol_count: "3" })
      await client.hset(`settings:trade_engine_state:${connId}`, { force_symbols: DEV_SYMBOLS, active_symbols: DEV_SYMBOLS, symbol_count: "3" })
      await client.hset(`settings:connection_settings:${connId}`, { force_symbols: DEV_SYMBOLS, active_symbols: DEV_SYMBOLS, symbol_count: "3" })
      // Clear any prehistoric cache gate so the engine re-runs with the new symbol set
      await client.del(`prehistoric_loaded:${connId}`).catch(() => 0)
      await client.del(`prehistoric:progress:${connId}`).catch(() => 0)
      console.log(`[v0] Migration 050: dev 3-symbol mode applied (${DEV_SYMBOLS})`)
    },
    down: async (client: any) => {
      await client.set("_schema_version", "49")
    },
  },
  {
    // Fix bingx-x01 operational state so the quickstart engine start works
    // correctly from a fresh DB:
    //   1. live_volume_factor: QUICKSTART_LIVE_VOLUME_FACTOR=0.1 is set by the
    //      quick-start route on every engine start. Migration 040 set it to 2.2
    //      but quick-start resets it to 0.1 each run. Setting it to 2.2 here is
    //      the resting default; quick-start will override during active sessions.
    //   2. is_assigned: "1" — marks bingx-x01 as a "Main Connection". The
    //      quick-start auto-discovery fallback requires this when no explicit
    //      connectionId is provided. Without it the engine start returns
    //      "No BingX connections found in Main Connections".
    //   3. is_enabled_dashboard: "1" — marks bingx-x01 as enabled in the
    //      dashboard panel so coordinator.startAll() includes it when called
    //      from /api/trade-engine/start (the Engine section header button).
    version: 51,
    name: "051-bingx-x01-operational-state",
    up: async (client: any) => {
      const connId = "bingx-x01"
      const hashes = [
        `connection:${connId}`,
        `settings:trade_engine_state:${connId}`,
        `settings:connection_settings:${connId}`,
      ]
      for (const h of hashes) {
        await client.hset(h, {
          live_volume_factor:   "2.2",
          volume_factor_live:   "2.2",
          is_assigned:          "1",
          is_enabled_dashboard: "1",
          is_active_inserted:   "1",
          // is_live_trade=1 enables the live-stage order placement gate.
          // Without this the simulated connector places no orders, placed=0
          // forever and trade history stays empty.
          is_live_trade:        "1",
          live_trade_enabled:   "1",
        }).catch(() => 0)
      }
      console.log("[v0] Migration 051: bingx-x01 operational state fixed (vol=2.2, is_live_trade=1, is_assigned=1)")
    },
    down: async (client: any) => {
      await client.set("_schema_version", "50")
    },
  },
  {
    // Enable live-order placement on bingx-x01 (simulated connector).
    // Migration 051 set vol/is_assigned/is_enabled_dashboard but omitted
    // is_live_trade — without it the live-stage skips order placement
    // entirely (isLiveTradeEnabled=false), placed=0 forever.
    version: 52,
    name: "052-bingx-x01-enable-live-trade",
    up: async (client: any) => {
      const connId = "bingx-x01"
      const hashes = [
        `connection:${connId}`,
        `settings:trade_engine_state:${connId}`,
        `settings:connection_settings:${connId}`,
      ]
      for (const h of hashes) {
        await client.hset(h, { is_live_trade: "1", live_trade_enabled: "1" }).catch(() => 0)
      }
      console.log("[v0] Migration 052: bingx-x01 is_live_trade=1 live_trade_enabled=1")
    },
    down: async (client: any) => {
      await client.set("_schema_version", "51")
    },
  },
  {
    // Reduce dev to a SINGLE symbol (BTCUSDT) for OOM survival.
    //
    // The dev VM has 4.39 GB physical RAM and NO swap; the kernel issues a
    // GLOBAL OOM-kill the moment total system RAM is exhausted (~2 GB
    // anon-rss for next-server). Migration 050 lowered dev to 3 symbols, but
    // even one prehistoric pass over 3 symbols bursts past the ceiling because
    // the Next.js dev worker already idles at ~1.7 GB.
    //
    // One symbol cuts the peak StrategySet allocation to ~1/3 and lets the
    // engine reach live_trading and stay there, which is what we need to
    // verify trade-history correctness and live-order placement (placed>0).
    // Symbol pinning now applies in all modes (guarded by V0_DEV_SYMBOL_COUNT).
    version: 53,
    name: "053-1-symbol-btcusdt-pin",
    up: async (client: any) => {
      const DEV_SYMBOLS = "BTCUSDT"
      const connId = "bingx-x01"
      await client.hset(`connection:${connId}`, { force_symbols: DEV_SYMBOLS, symbol_count: "1" }).catch(() => 0)
      await client.hset(`settings:trade_engine_state:${connId}`, { force_symbols: DEV_SYMBOLS, active_symbols: DEV_SYMBOLS, symbol_count: "1" }).catch(() => 0)
      await client.hset(`settings:connection_settings:${connId}`, { force_symbols: DEV_SYMBOLS, active_symbols: DEV_SYMBOLS, symbol_count: "1" }).catch(() => 0)
      // Clear prehistoric cache gates so the engine re-runs with the new set.
      await client.del(`prehistoric_loaded:${connId}`).catch(() => 0)
      await client.del(`prehistoric:progress:${connId}`).catch(() => 0)
      console.log(`[v0] Migration 053: dev 1-symbol OOM-survival mode applied (${DEV_SYMBOLS})`)
    },
    down: async (client: any) => {
      await client.set("_schema_version", "52")
    },
  },
  {
    // Dual-connection always-inited bootstrap.
    //
    // bybit-x03 was previously in legacyIds (deleted every boot) and absent
    // from BASE_CONNECTION_CONFIG, so it never appeared in the dashboard.
    // Now it is a canonical base connection again (session 4) but existing
    // Redis snapshots still have the stale/deleted hash. This migration:
    //
    //   1. Deletes the stale bybit-x03 hashes entirely so ensureBaseConnections
    //      (which runs every boot AFTER migrations) re-seeds it from scratch
    //      with the correct autoActive=true defaults (is_active_inserted=1,
    //      is_dashboard_inserted=1, is_enabled_dashboard=0).
    //
    //   2. Ensures bingx-x01 is_active_inserted=1 / is_dashboard_inserted=1
    //      so it appears in the Active panel (it was somehow stripped to
    //      active_inserted=False in the prior snapshot).
    //
    //   3. Re-confirms is_live_trade=1 / live_trade_enabled=1 on bingx-x01
    //      in case migration 042 LEGACY_DEFAULT_VALUES zeroed it and 051/052
    //      didn't fully recover it due to ordering.
    //
    //   4. Removes bybit-x03 from the connections:tombstoned set (if present)
    //      so ensureBaseConnections doesn't skip it.
    version: 54,
    name: "054-dual-connection-always-inited",
    up: async (client: any) => {
      // ── 1. Remove bybit-x03 from tombstone so ensureBaseConnections seeds it ──
      await client.srem("connections:tombstoned", "bybit-x03").catch(() => 0)

      // ── 2. Wipe stale bybit-x03 hashes so ensureBaseConnections does a clean
      //       first-time seed. The operator-state-preservation contract in
      //       ensureBaseConnections only applies to EXISTING rows; a fresh
      //       seed applies the full canonical defaults including autoActive flags.
      const bybitHashes = [
        "connection:bybit-x03",
        "settings:trade_engine_state:bybit-x03",
        "settings:connection_settings:bybit-x03",
      ]
      for (const h of bybitHashes) {
        await client.del(h).catch(() => 0)
      }

      // ── 3. Ensure bingx-x01 is active-inserted (visible in Active panel) ──
      //       and has is_live_trade=1. Use conditional hset: only write flags
      //       that are currently absent or wrong. This preserves any other
      //       operator customisations on the hash.
      const bingxConn = await client.hgetall("connection:bingx-x01").catch(() => ({})) as Record<string,string>
      const bingxFixes: Record<string, string> = {}
      if (!bingxConn?.is_active_inserted || bingxConn.is_active_inserted === "0") {
        bingxFixes.is_active_inserted    = "1"
      }
      if (!bingxConn?.is_dashboard_inserted || bingxConn.is_dashboard_inserted === "0") {
        bingxFixes.is_dashboard_inserted = "1"
      }
      if (!bingxConn?.is_inserted || bingxConn.is_inserted === "0") {
        bingxFixes.is_inserted = "1"
      }
      if (!bingxConn?.is_live_trade || bingxConn.is_live_trade === "0" || bingxConn.is_live_trade === "false") {
        bingxFixes.is_live_trade       = "1"
        bingxFixes.live_trade_enabled  = "1"
      }
      if (Object.keys(bingxFixes).length > 0) {
        await client.hset("connection:bingx-x01", bingxFixes).catch(() => 0)
        await client.hset("settings:trade_engine_state:bingx-x01", bingxFixes).catch(() => 0)
        await client.hset("settings:connection_settings:bingx-x01", bingxFixes).catch(() => 0)
      }

      console.log("[v0] Migration 054: dual-connection bootstrap — bybit-x03 wiped for fresh seed, bingx-x01 flags ensured")
    },
    down: async (client: any) => {
      await client.set("_schema_version", "53")
    },
  },
  {
    // System-wide default change (operator request session 5):
    //   • Volume factor → minimalist 0.1 (was 2.2). VolumeCalculator already
    //     treats 0.1 as the canonical minimum when unset; this makes it the
    //     EXPLICIT seeded default on the live connections too.
    //   • Default symbol selection → top-6 by 1h volatility (PROD). symbol_order
    //     is set to "volatility_1h" and getSymbols() now performs dynamic
    //     top-N selection via fetchTopSymbols(...,"volatility_1h") whenever no
    //     explicit operator force_symbols is present.
    //   • DEV stays capped LOWER (2 symbols) for OOM survival on the 4.39 GB
    //     no-swap VM — still uses volatility selection (top-2), just fewer of
    //     them. Production uses the full 6.
    //
    // To activate dynamic volatility selection we must CLEAR the migration-seeded
    // force_symbols / active_symbols / symbols overrides that 053 (dev 1-symbol)
    // and earlier migrations wrote — otherwise getSymbols() short-circuits on
    // those and the volatility branch never runs. We also clear the prehistoric
    // gates so the engine re-selects + re-runs on next start.
    version: 55,
    name: "055-default-volume-0.1-and-6-symbols-by-volatility",
    up: async (client: any) => {
      const symbolCount = String(Math.max(1, parseInt(process.env.V0_DEV_SYMBOL_COUNT ?? "4", 10) || 4))
      const connIds = ["bingx-x01", "bybit-x03"]

      for (const connId of connIds) {
        const hashes = [
          `connection:${connId}`,
          `settings:trade_engine_state:${connId}`,
          `settings:connection_settings:${connId}`,
        ]
        for (const h of hashes) {
          // Set the new minimalist volume default + volatility ordering config.
          await client.hset(h, {
            live_volume_factor: "0.1",
            volume_factor_live: "0.1",
            symbol_count:       symbolCount,
            symbol_order:       "volatility_1h",
          }).catch(() => 0)
          // Clear seeded symbol overrides so dynamic volatility selection runs.
          await client.hdel(h, "force_symbols", "active_symbols", "symbols").catch(() => 0)
        }
        // Clear prehistoric cache gates so the engine re-selects + re-runs.
        await client.del(`prehistoric_loaded:${connId}`).catch(() => 0)
        await client.del(`prehistoric:progress:${connId}`).catch(() => 0)
      }

      // Also set the global VolumeCalculator fallback to the new default.
      await client.hset("app_settings", { live_volume_factor: "0.1", volume_factor_live: "0.1" }).catch(() => 0)

      console.log(
        `[v0] Migration 055: defaults updated — volume_factor=0.1, symbol_count=${symbolCount} ` +
          `symbol_order=volatility_1h; cleared force/active symbol overrides`,
      )
    },
    down: async (client: any) => {
      await client.set("_schema_version", "54")
    },
  },
  {
    version: 56,
    name: "056-normalize-variant-toggles",
    // Establish a CONSISTENT, explicit strategy-variant toggle map across the
    // whole system. The coordinator resolves toggles as app_settings (global
    // fallback) overlaid with connection_settings:{id}. Migration 040 seeded
    // these only into connection_settings:bingx-x01, leaving (a) the global
    // app_settings fallback and (b) the later-added bybit-x03 connection with
    // NO explicit toggles — so they silently relied on code defaults. This
    // migration seeds the canonical map (trailing=on, block=on, dca=OFF,
    // + block tuning) wherever a key is ABSENT, so the state is
    // explicit and uniform. SET-IF-ABSENT: an operator's deliberate override
    // is never clobbered (we only fill in keys that don't exist yet).
    up: async (client: any) => {
      const canonical: Record<string, string> = {
        variantTrailingEnabled: "true",
        variantBlockEnabled:    "true",
        variantDcaEnabled:      "false", // spec: DCA OFF by default
        blockVolumeRatio:       "1.0",
        blockMaxStack:          "10",
        blockPauseCountRatio: "1.0",
        blockActiveRealEnabled: "true",
        blockActiveLiveEnabled: "true",
      }
      const seedIfAbsent = async (hashKey: string) => {
        const existing = ((await client.hgetall(hashKey).catch(() => ({}))) || {}) as Record<string, string>
        const toWrite: Record<string, string> = {}
        for (const [k, v] of Object.entries(canonical)) {
          const cur = existing[k]
          if (cur === undefined || cur === null || cur === "") toWrite[k] = v
        }
        if (Object.keys(toWrite).length > 0) {
          await client.hset(hashKey, toWrite).catch(() => 0)
        }
        return Object.keys(toWrite)
      }

      const appSeeded = await seedIfAbsent("app_settings")
      const targets = ["bingx-x01", "bybit-x03"]
      const connSeeded: Record<string, string[]> = {}
      for (const id of targets) {
        connSeeded[id] = await seedIfAbsent(`connection_settings:${id}`)
      }

      console.log(
        `[v0] Migration 056: normalized variant toggles (dca OFF by default) — ` +
          `app_settings seeded [${appSeeded.join(",") || "none"}]; ` +
          targets.map((id) => `${id} seeded [${connSeeded[id].join(",") || "none"}]`).join("; "),
      )
    },
    down: async (client: any) => {
      await client.set("_schema_version", "55")
    },
  },
  {
    // Migration 055 sets symbol_count=2 + symbol_order=volatility_1h + clears
    // force_symbols for BOTH dev and prod. In dev that can leave the engine
    // doing volatile API calls across many symbols before any boot guard runs.
    //
    // This migration re-applies the V0_DEV_SYMBOL_COUNT cap (default 1 =
    // BTCUSDT pin) AFTER 055 so the dev engine always starts with the correct
    // symbol set regardless of snapshot state. Production is unaffected.
    version: 57,
    name: "057-symbol-count-repin",
    up: async (client: any) => {
      const devSymCount = Math.max(1, parseInt(process.env.V0_DEV_SYMBOL_COUNT ?? "4", 10) || 4)
      const connId = "bingx-x01"
      const hashes = [
        `connection:${connId}`,
        `settings:trade_engine_state:${connId}`,
        `settings:connection_settings:${connId}`,
      ]
      if (devSymCount === 1) {
        const DEV_SYMBOL = "BTCUSDT"
        for (const h of hashes) {
          await client.hset(h, {
            force_symbols:  JSON.stringify([DEV_SYMBOL]),
            symbol_count:   "1",
            symbol_order:   "",
            symbols:        JSON.stringify([DEV_SYMBOL]),
            active_symbols: JSON.stringify([DEV_SYMBOL]),
          }).catch(() => 0)
        }
        console.log(`[v0] Migration 057: dev 1-symbol repin — force_symbols=${DEV_SYMBOL}`)
      } else {
        // Multi-symbol: clear force_symbols, set count and volatility order.
        for (const h of hashes) {
          await client.hset(h, {
            force_symbols:  "",
            symbol_count:   String(devSymCount),
            symbol_order:   "volatility_1h",
            symbols:        "",
            active_symbols: "",
          }).catch(() => 0)
        }
        console.log(`[v0] Migration 057: dev multi-symbol repin — symbol_count=${devSymCount} volatility_1h`)
      }
      // Clear prehistoric gates so the engine re-runs with the correct symbols.
      await client.del(`prehistoric_loaded:${connId}`).catch(() => 0)
      await client.del(`prehistoric:progress:${connId}`).catch(() => 0)
    },
    down: async (client: any) => {
      await client.set("_schema_version", "56")
    },
  },

  {
    version: 58,
    name: "058-indication-tracking-fields",
    up: async (client: any) => {
      // Backfill `indication_sets_total` and `indication_sets_at_limit` onto all
      // existing `progression:{connId}` hashes that pre-date this migration.
      // These fields are read by getIndicationTracking (detailed-tracking.ts) and
      // written by IndicationSetsProcessor.processAllIndicationSets and the
      // generate-indications cron on every cycle.  We use HSETNX (SET-IF-ABSENT)
      // so already-running engines that have already written a non-zero value are
      // never zeroed out by the migration.
      const connSet = await client.smembers("connections").catch(() => [] as string[])
      const connIds: string[] = Array.isArray(connSet) ? connSet : []
      let patched = 0
      for (const connId of connIds) {
        const progKey = `progression:${connId}`
        const exists = await client.exists(progKey).catch(() => 0)
        if (!exists) continue
        // Only seed fields that are genuinely absent (empty string or undefined).
        const current = await client.hgetall(progKey).catch(() => ({})) as Record<string, string>
        const toWrite: Record<string, string> = {}
        if (!current.indication_sets_total)   toWrite.indication_sets_total   = "0"
        if (!current.indication_sets_at_limit) toWrite.indication_sets_at_limit = "0"
        if (!current.indications_count)       toWrite.indications_count       = "0"
        if (Object.keys(toWrite).length > 0) {
          await client.hset(progKey, toWrite).catch(() => 0)
          patched++
        }
      }
      console.log(`[v0] Migration 058: seeded indication_sets_total/at_limit on ${patched}/${connIds.length} progression hashes`)
    },
    down: async (client: any) => {
      await client.set("_schema_version", "57")
    },
  },
  {
    // Apply V0_DEV_SYMBOL_COUNT to bingx-x01 symbol settings.
    // This migration runs at the correct version point so raising or lowering
    // V0_DEV_SYMBOL_COUNT (and deleting the snapshot to force a re-migration)
    // correctly resets the symbol config.  In production this is a no-op.
    version: 59,
    name: "059-multi-symbol-support",
    up: async (client: any) => {
      const devSymCount = Math.max(1, parseInt(process.env.V0_DEV_SYMBOL_COUNT ?? "4", 10) || 4)
      const connId = "bingx-x01"
      const hashes = [
        `connection:${connId}`,
        `settings:trade_engine_state:${connId}`,
        `settings:connection_settings:${connId}`,
      ]
      if (devSymCount === 1) {
        const DEV_SYM = "BTCUSDT"
        for (const h of hashes) {
          await client.hset(h, {
            force_symbols:  JSON.stringify([DEV_SYM]),
            symbol_count:   "1",
            symbol_order:   "",
            symbols:        JSON.stringify([DEV_SYM]),
            active_symbols: JSON.stringify([DEV_SYM]),
          }).catch(() => 0)
        }
        console.log("[v0] Migration 059: dev 1-symbol (BTCUSDT)")
      } else {
        for (const h of hashes) {
          await client.hset(h, {
            force_symbols:  "",
            symbol_count:   String(devSymCount),
            symbol_order:   "volatility_1h",
            symbols:        "",
            active_symbols: "",
          }).catch(() => 0)
        }
        // Clear prehistoric gates so the engine re-runs with the new symbol set.
        await client.del(`prehistoric_loaded:${connId}`).catch(() => 0)
        await client.del(`prehistoric:progress:${connId}`).catch(() => 0)
        console.log(`[v0] Migration 059: dev ${devSymCount}-symbol volatility_1h`)
      }
    },
    down: async (client: any) => {
      await client.set("_schema_version", "58")
    },
  },
  {
    version: 60,
    name: "060-purge-ghost-connection-hashes",
    up: async (client: any) => {
      // Purge `connection:*` keys whose hash has no `id` field — these are
      // leftover ghost entries from aborted saves or partial migrations that
      // trigger a recurring `getAllConnections: skipping malformed connection
      // hash` log on every poll interval. Safe to delete: any legitimate
      // connection always has at least `id`, `name`, and `exchange` written
      // atomically by `saveConnection`.
      let purged = 0
      try {
        const allKeys: string[] = await client.keys("connection:*")
        for (const key of allKeys) {
          try {
            const id = await client.hget(key, "id")
            const name = await client.hget(key, "name")
            const exchange = await client.hget(key, "exchange")
            if (!id || !name || !exchange) {
              await client.del(key)
              purged++
              console.log(`[v0] Migration 060: deleted ghost key ${key}`)
            }
          } catch { /* skip individual key errors */ }
        }
      } catch (err) {
        console.warn("[v0] Migration 060: keys scan failed (non-fatal):", err)
      }
      console.log(`[v0] Migration 060: purged ${purged} ghost connection hashes`)
    },
    down: async (client: any) => {
      await client.set("_schema_version", "59")
    },
  },
  {
    // Purge multi-symbol stale state so the local server (dev or local prod build)
    // can boot on a single BTCUSDT symbol without OOM-killing from leftover keys
    // written by a previous 10-symbol run.
    //
    // Deleted key families:
    //   live:position:*          — sim positions for non-BTCUSDT symbols
    //   live:position:tracking:* — tracking pointers
    //   prehistoric:bingx-x01:*  — prehistoric candle/progress data per symbol
    //   pseudo_position:*        — sim pseudo-positions that belonged to
    //                             non-BTCUSDT symbols
    //   realtime:bingx-x01       — stale cycle counters (reset to 0 on next cycle)
    //   real:sets:bingx-x01:*    — stale set evaluations for non-BTCUSDT symbols
    //   strategy:bingx-x01:*     — stale strategy variant data
    //
    version: 61,
    name: "061-purge-multi-symbol-stale-state",
    up: async (client: any) => {
      const KEEP_SYMBOL = "BTCUSDT"
      let purged = 0
      // Helper: delete all keys in a family that do NOT contain KEEP_SYMBOL
      const purgeFamily = async (prefix: string) => {
        try {
          const keys: string[] = await client.keys(`${prefix}*`)
          for (const key of keys) {
            // Keep BTCUSDT keys and any pure-container keys (no symbol suffix)
            if (!key.includes(":") || key.toUpperCase().includes(KEEP_SYMBOL)) continue
            await client.del(key).catch(() => 0)
            purged++
          }
        } catch { /* non-fatal */ }
      }
      await purgeFamily("live:position:")
      await purgeFamily("prehistoric:bingx-x01:")
      await purgeFamily("pseudo_position:bingx-x01:")
      await purgeFamily("real:sets:bingx-x01:")
      await purgeFamily("strategy:bingx-x01:")
      await purgeFamily("indication_outcomes_pending:")
      // Also purge bybit-x03 engine state so it doesn't try to restart
      try {
        const bybitKeys: string[] = await client.keys("*bybit-x03*")
        for (const key of bybitKeys) {
          if (key.startsWith("connection:") || key.startsWith("settings:")) continue
          await client.del(key).catch(() => 0)
          purged++
        }
      } catch { /* non-fatal */ }
      // Reset live position counters on the bingx-x01 progression hash
      await client.hset("progression:bingx-x01", {
        live_positions_open: "0",
        live_orders_placed_count: "0",
        live_positions_closed: "0",
      }).catch(() => 0)
      console.log(`[v0] Migration 061: purged ${purged} stale multi-symbol keys (kept ${KEEP_SYMBOL})`)
    },
    down: async (client: any) => {
      await client.set("_schema_version", "60")
    },
  },
  {
    version: 62,
    name: "062-separate-main-assignment-from-processing",
    up: async (client: any) => {
      await client.set("_schema_version", "62")
      const truthy = (value: any) => value === true || value === 1 || value === "1" || value === "true"
      const connections = await client.smembers("connections")
      let backfilled = 0
      let indexed = 0

      await client.del("connections:main:enabled").catch(() => 0)

      for (const connId of connections) {
        const connData = await client.hgetall(`connection:${connId}`)
        if (!connData || Object.keys(connData).length === 0) continue

        const assigned = truthy(connData.is_active_inserted) || truthy(connData.is_assigned) || truthy(connData.is_dashboard_inserted)
        const processingEnabled = truthy(connData.is_enabled_dashboard)
        const hasLegacyActiveOnly = truthy(connData.is_active_inserted) && !processingEnabled

        if (hasLegacyActiveOnly) {
          await client.hset(`connection:${connId}`, {
            is_assigned: "1",
            is_enabled_dashboard: "0",
            is_active: "0",
            updated_at: new Date().toISOString(),
          })
          backfilled++
        } else if (assigned && processingEnabled) {
          await client.sadd("connections:main:enabled", connId)
          indexed++
        }
      }

      console.log(
        `[v0] Migration 062: separated assignment from processing; ` +
        `backfilled ${backfilled} legacy active-only row(s), indexed ${indexed} processing-enabled row(s)`,
      )
    },
    down: async (client: any) => {
      await client.set("_schema_version", "61")
    },
  },
  {
    version: 63,
    name: "063-reset-legacy-indication-snapshots",
    up: async (client: any) => {
      // Old production builds wrote mixed indication snapshot shapes:
      //   direction=123                (legacy plain cumulative-ish field)
      //   BTCUSDT:direction=1         (current per-symbol current-cycle field)
      // Window readers now prefer scoped fields, but hosted Redis instances can
      // retain stale legacy fields for days. Clear only short-lived snapshot
      // hashes so the next engine/cron tick rebuilds truthful current values;
      // do NOT touch cumulative progression counters or historical stats.
      const patterns = [
        "indications_active:*",
        "indications_window:*:last5",
        "indications_window:*:last60min",
      ]
      let deleted = 0
      for (const pattern of patterns) {
        const keys = ((await client.keys(pattern).catch(() => [])) || []) as string[]
        if (keys.length === 0) continue
        await client.del(...keys).catch(() => 0)
        deleted += keys.length
      }
      console.log(`[v0] Migration 063: reset ${deleted} legacy/stale indication snapshot key(s)`)
    },
    down: async (client: any) => {
      await client.set("_schema_version", "62")
    },
  },
  {
    version: 64,
    name: "064-split-raw-and-set-indication-snapshots",
    up: async (client: any) => {
      // v63 normalized legacy plain/scoped fields, but older production builds
      // still used the same short-lived keys for two different meanings:
      //   indications_active/window      = raw signal counts (0/1-ish)
      //   indications_active/window      = set-qualified config counts (can be 30+)
      // v64 moves set-qualified snapshots to indication_sets_* keys. Clear the
      // old shared raw namespace so the raw processor/cron repopulates it with
      // raw counts only; do not touch cumulative progression counters.
      const patterns = [
        "indications_active:*",
        "indications_window:*:last5",
        "indications_window:*:last60min",
      ]
      let deleted = 0
      for (const pattern of patterns) {
        const keys = ((await client.keys(pattern).catch(() => [])) || []) as string[]
        if (keys.length === 0) continue
        await client.del(...keys).catch(() => 0)
        deleted += keys.length
      }
      console.log(`[v0] Migration 064: cleared ${deleted} conflicting raw/set indication snapshot key(s)`)
    },
    down: async (client: any) => {
      await client.set("_schema_version", "63")
    },
  },
  {
    version: 65,
    name: "065-dev-prod-database-health-metadata",
    up: async (client: any) => {
      const mode = process.env.NODE_ENV === "production" ? "production" : "development"
      const now = new Date().toISOString()
      const finalVersion = Math.max(...migrations.map((m) => m.version))

      // This migration is intentionally environment-neutral. Development and
      // production both need a single lightweight, queryable health record so
      // startup/status routes can verify that the Redis schema on disk matches
      // the migration bundle that booted the process. Keep this metadata small:
      // no key scans, no progression resets, no strategy rewrites.
      await client.hset("system:database:health", {
        mode,
        schema_version: String(finalVersion),
        migrations_bundle_version: String(finalVersion),
        migrations_sequential: "1",
        last_verified_at: now,
      })
      await client.set("_migrations_run", "true")
      console.log(`[v0] Migration 065: recorded ${mode} database health metadata at schema v${finalVersion}`)
    },
    down: async (client: any) => {
      await client.hdel(
        "system:database:health",
        "mode",
        "schema_version",
        "migrations_bundle_version",
        "migrations_sequential",
        "last_verified_at",
      ).catch(() => 0)
      await client.set("_schema_version", "64")
    },
  },
]

export function getLatestMigrationVersion(): number {
  return Math.max(...migrations.map((m) => m.version))
}

const BASE_CONNECTION_CONFIG: Array<{
  id: string
  name: string
  exchange: string
  credentialId: BaseConnectionId
  autoActive: boolean
}> = [
  // Spec ask: "assign Main Connections bybit and bingx ON Startup."
  // Bybit-X03 and BingX-X01 are the canonical primary live-trading
  // connections — they are auto-inserted into the Active panel AND the
  // dashboard toggle is defaulted ON during *first* creation. Any
  // existing operator override (e.g. user explicitly disabled the
  // dashboard toggle) is preserved by the existing `(existing?.is_*) || …`
  // fallback chain in `ensureBaseConnections` below — autoActive only
  // affects the initial-create defaults, never overwrites prior state.
  { id: "bingx-x01", name: "BingX Base", exchange: "bingx", credentialId: "bingx-x01", autoActive: true },
  // Bybit is once again a canonical primary: always inited + inserted into the
  // Active panel so it is visible from first boot. Its ENGINE does not run by
  // default in dev (see the dev one-engine guard in
  // TradeEngineCoordinator.startMissingEngines) — it stays engine-idle until the
  // operator explicitly enables it, which prevents two concurrent prehistoric
  // passes from OOM-killing the low-RAM dev VM. In production both engines run.
  { id: "bybit-x03", name: "Bybit Base", exchange: "bybit", credentialId: "bybit-x03", autoActive: true },
  { id: "pionex-x01", name: "Pionex Base", exchange: "pionex", credentialId: "pionex-x01", autoActive: false },
  { id: "orangex-x01", name: "OrangeX Base", exchange: "orangex", credentialId: "orangex-x01", autoActive: false },
]

// Canonical 20-symbol test list used by migration 031, migration 035, and
// ensureBaseConnections. Declared once here to avoid drift between the three
// call-sites that previously each contained an inline copy of the array.
const BASE_TEST_SYMBOLS = [
  "BTCUSDT",  "ETHUSDT",  "SOLUSDT",  "BNBUSDT",  "XRPUSDT",
  "DOGEUSDT", "ADAUSDT",  "AVAXUSDT", "LINKUSDT", "DOTUSDT",
  "ATOMUSDT", "LTCUSDT",  "UNIUSDT",  "NEARUSDT", "POLUSDT",
  "AAVEUSDT", "SUIUSDT",  "APTUSDT",  "ARBUSDT",  "OPUSDT",
]

async function ensureBaseConnections(client: any): Promise<{ createdOrUpdated: number; credentialsInjected: number }> {
  let createdOrUpdated = 0
  let credentialsInjected = 0

  // Default symbol count: 4 for all modes. Controlled via V0_DEV_SYMBOL_COUNT env var.
  const DEFAULT_SYMBOL_COUNT = String(Math.max(1, parseInt(process.env.V0_DEV_SYMBOL_COUNT ?? "4", 10) || 4))

  // bybit-x03 is NO LONGER in this list: it is once again a canonical base
  // connection (see BASE_CONNECTION_CONFIG) and is always inited + visible
  // alongside bingx-x01. The remaining ids are genuinely obsolete schema rows
  // that must be cleaned up so they don't appear as ghost connections.
  const legacyIds = ["bybit-base", "bingx-base", "binance-base", "okx-base", "bybit-default-disabled", "bingx-default-disabled"]
  for (const legacyId of legacyIds) {
    const exists = await client.sismember("connections", legacyId)
    if (exists) {
      await client.del(`connection:${legacyId}`)
      await client.srem("connections", legacyId)
      console.log(`[v0] [Migrations] Removed legacy connection id ${legacyId}`)
    }
  }

  // ���─ Honour operator-issued tombstones ────────────────────────────
  // The DELETE endpoint (`app/api/settings/connections/[id]/route.ts`)
  // adds deleted connection IDs to the `connections:tombstoned` Set so
  // we don't immediately resurrect them on the next migration sweep
  // (which historically ran every cold start and silently un-did the
  // operator's delete). Read the set once up-front so we don't query
  // Redis per-config inside the loop below.
  const tombstonedIds = new Set<string>()
  try {
    const tombs = await client.smembers("connections:tombstoned")
    if (Array.isArray(tombs)) {
      for (const id of tombs) {
        if (typeof id === "string" && id.length > 0) tombstonedIds.add(id)
      }
    }
  } catch {
    // Non-critical: a missing/corrupt set just means we treat it as empty.
  }

  for (const cfg of BASE_CONNECTION_CONFIG) {
    if (tombstonedIds.has(cfg.id)) {
      // Operator explicitly deleted this base connection — don't
      // recreate it. Logged at INFO so the cold-start log makes the
      // skip visible.
      console.log(
        `[v0] [Migrations] Skipping tombstoned base connection ${cfg.id} ` +
        `(deleted by operator; will not be auto-recreated)`,
      )
      continue
    }
    const now = new Date().toISOString()
    const existing = await client.hgetall(`connection:${cfg.id}`)
    const hasExisting = existing && Object.keys(existing).length > 0

    const { apiKey, apiSecret } = getBaseConnectionCredentials(cfg.credentialId)
    const hasRealCredentials = apiKey.length > 10 && apiSecret.length > 10

    // ── OPERATOR-STATE PRESERVATION CONTRACT ──────────────────────────
    // Bug being fixed (operator report): "after removing main connections,
    // it's getting re-added by some procedure".
    //
    // Root cause: previous version unconditionally set
    //   is_active_inserted: cfg.autoActive ? "1" : ...
    // for autoActive base connections (bingx-x01). Every
    // cold-start (or any code path that calls `initRedis` followed by
    // `runMigrations` — which is essentially every Vercel function
    // invocation) re-flipped the flag back to "1", undoing the
    // operator's explicit DELETE on `/api/settings/connections/[id]/active`.
    //
    // Same class of bug applies to is_inserted, is_dashboard_inserted,
    // is_enabled, is_enabled_dashboard, is_active — the previous code
    // used `(existing || default)` patterns which mostly worked for
    // string "0" (truthy in JS), but the autoActive override branch did
    // not, AND the structural fields (api_type, connection_method, etc)
    // could clobber operator-chosen values via the `||` fallback.
    //
    // New contract for EXISTING connections:
    //   * STRUCTURAL fields  → kept as-is (id, name, exchange,
    //                          api_type, connection_method, etc).
    //                          Migrations 015-018 are the canonical
    //                          place for one-time structural rewrites;
    //                          this ensure-pass is a SAFETY NET, not a
    //                          schema enforcer.
    //   * OPERATOR FLAG fields (is_inserted, is_active_inserted,
    //                          is_dashboard_inserted, is_enabled,
    //                          is_enabled_dashboard, is_active) →
    //                          NEVER touched. The operator's last
    //                          choice via the dashboard wins.
    //   * CREDENTIALS         → injected from env when available, even
    //                          on existing rows (so credential rotation
    //                          via env var works without re-saving).
    //   * `updated_at`        → bumped only when credentials actually
    //                          changed, so we don't generate spurious
    //                          dashboard "connection updated" toasts on
    //                          every cold-start.
    //
    // For BRAND-NEW connections (no existing row in Redis): seed every
    // field with the canonical defaults — that's the only time we get
    // to choose. The `autoActive` hint controls the initial insertion +
    // dashboard-enable defaults so a fresh DB still surfaces Bybit/BingX
    // ready to go.

    if (!hasExisting) {
      // First-time seed. Apply full canonical defaults.
      const seedData: Record<string, string> = {
        id: cfg.id,
        name: cfg.name,
        exchange: cfg.exchange,
        is_predefined: "0",
        is_inserted: "1",
        // AUTO-START DISABLED: never seed connections as dashboard-enabled.
        // `autoActive` now only controls insertion + symbol/live-trade seeding;
        // the operator must explicitly enable the connection via the dashboard.
        // autoActive connections (bingx-x01) are inserted and visible in the
        // Active panel from the very first boot. This does NOT start the engine —
        // the operator must explicitly click Start. Without this flag the
        // connections route reports "inserted=0" and Smart Overview shows 0/0.
        is_dashboard_inserted: cfg.autoActive ? "1" : "0",
        is_active_inserted: cfg.autoActive ? "1" : "0",
        is_enabled: "1",
        // is_enabled_dashboard stays 0 on fresh seed — operator must explicitly
        // enable via the dashboard toggle. Only is_active_inserted (visibility)
        // is pre-set; is_enabled_dashboard (processing) requires operator action.
        is_enabled_dashboard: "0",
        is_active: "0",
        connection_method: "library",
        connection_library: "native",
        api_type: "perpetual_futures",
        api_key: hasRealCredentials ? apiKey : "",
        api_secret: hasRealCredentials ? apiSecret : "",
        created_at: now,
        updated_at: now,
      }
      // For the primary autoActive BingX connection seed is_live_trade + the
      // volatility-selection config so live-trade testing works immediately
      // after a dev restart without requiring the operator to re-configure.
      //
      // NOTE: we intentionally do NOT seed a static active_symbols list. The
      // new system default (migration 055) is dynamic top-N selection by 1h
      // volatility — getSymbols() performs that selection whenever no explicit
      // force_symbols and no self-written symbols exist. Seeding a static list
      // here would short-circuit that branch. symbol_count controls N
      // (6 in prod, capped to 2 in dev for OOM survival).
      if (cfg.autoActive && cfg.exchange === "bingx") {
        seedData["is_live_trade"]     = "1"
        seedData["symbol_count"]      = DEFAULT_SYMBOL_COUNT
        seedData["symbol_order"]      = "volatility_1h"
        seedData["live_volume_factor"] = "0.1"
        seedData["volume_factor_live"] = "0.1"
        seedData["position_mode"]     = "hedge"
      }
      await client.hset(`connection:${cfg.id}`, seedData)
      await client.sadd("connections", cfg.id)

      // Seed the connection_settings hash at the same time so VolumeCalculator
      // picks up exchangePositionCost immediately (min notional for test trades).
      if (cfg.autoActive && cfg.exchange === "bingx") {
        const settKey = `connection_settings:${cfg.id}`
        const existSett = (await client.hgetall(settKey).catch(() => null)) as Record<string,string> | null
        const haveSett = existSett || {}
        const settWrites: Record<string,string> = {}
        if (!haveSett["exchangePositionCost"]) settWrites["exchangePositionCost"] = "0.02"
        if (!haveSett["positions_average"])    settWrites["positions_average"]    = "2"
        if (Object.keys(settWrites).length > 0) {
          await client.hset(settKey, settWrites)
        }

        // getSymbols() reads from settings:trade_engine_state:{id} and
        // settings:connection:{id} (setSettings-prefixed keys) NOT the bare
        // connection:{id} hash. Write to both prefixed keys so the engine
        // resolves 5 symbols on the very first tick without waiting for the
        // PATCH route to push active_symbols into the engine-state key.
        // Seed the volatility-selection config (NOT a static symbol list) to
        // the setSettings-prefixed keys that getSymbols() reads. Leaving
        // active_symbols empty lets getSymbols() do dynamic top-N selection.
        const engineStateKey = `settings:trade_engine_state:${cfg.id}`
        await client.hset(engineStateKey, {
          symbol_count:             DEFAULT_SYMBOL_COUNT,
          symbol_order:             "volatility_1h",
          config_set_symbols_total: DEFAULT_SYMBOL_COUNT,
          live_volume_factor:       "0.1",
        }).catch(() => {})
        const settConnKey = `settings:connection:${cfg.id}`
        await client.hset(settConnKey, {
          symbol_count: DEFAULT_SYMBOL_COUNT,
          symbol_order: "volatility_1h",
        }).catch(() => {})
      }

      if (hasRealCredentials) credentialsInjected++
      createdOrUpdated++
      continue
    }

    // Existing connection: repair missing selection defaults only.
    // Never re-enable `is_live_trade` here: it is an operator-controlled flag
    // and migrations/bootstraps run during every production cold start. The
    // first-time seed above may choose a fresh default, but an existing row with
    // `is_live_trade = "0"` means the operator disabled live trading and must
    // stay disabled until the live-trade route or explicit Start changes it.
    {
      // We no longer require a static active_symbols list — the default is
      // dynamic top-N selection by 1h volatility (getSymbols). We only ensure
      // missing selection config (symbol_count / symbol_order / volume) is
      // present so the engine can pick symbols on the first tick. We never seed
      // a static symbol list here.
      const hasOrder = String(existing["symbol_order"] ?? "").length > 0
      const needsSelectionRepair =
        !hasOrder || !existing["symbol_count"] || !existing["live_volume_factor"] || !existing["position_mode"]
      if (cfg.autoActive && cfg.exchange === "bingx" && needsSelectionRepair) {
        const patchData: Record<string,string> = {}
        if (!hasOrder) patchData["symbol_order"] = "volatility_1h"
        if (!existing["symbol_count"]) patchData["symbol_count"] = DEFAULT_SYMBOL_COUNT
        if (!existing["live_volume_factor"]) patchData["live_volume_factor"] = "0.1"
        if (!existing["position_mode"]) patchData["position_mode"] = "hedge"
        if (Object.keys(patchData).length > 0) {
          await client.hset(`connection:${cfg.id}`, patchData)
        }
        const settKey2 = `connection_settings:${cfg.id}`
        const existSett2 = (await client.hgetall(settKey2).catch(() => null)) as Record<string,string> | null
        const haveSett2 = existSett2 || {}
        const settWrites2: Record<string,string> = {}
        if (!haveSett2["exchangePositionCost"]) settWrites2["exchangePositionCost"] = "0.02"
        if (!haveSett2["positions_average"])    settWrites2["positions_average"]    = "2"
        if (Object.keys(settWrites2).length > 0) {
          await client.hset(settKey2, settWrites2)
        }

        // Push the selection config to the setSettings-prefixed keys that
        // getSymbols() reads — without a static symbol list, so the dynamic
        // volatility branch runs on the first engine tick.
        await client.hset(`settings:trade_engine_state:${cfg.id}`, {
          symbol_count:             DEFAULT_SYMBOL_COUNT,
          symbol_order:             "volatility_1h",
          config_set_symbols_total: DEFAULT_SYMBOL_COUNT,
        }).catch(() => {})
        await client.hset(`settings:connection:${cfg.id}`, {
          symbol_count: DEFAULT_SYMBOL_COUNT,
          symbol_order: "volatility_1h",
        }).catch(() => {})
      }
    }

    // Existing connection: PRESERVE every operator-controlled field.
    // The only values we touch are:
    //   1. Credentials (rotate from env when available).
    //   2. The connection-set membership (in case a manual SREM ever
    //      desyncs the index from the hash — defensive only).
    const updates: Record<string, string> = {}
    let didChange = false

    if (hasRealCredentials) {
      const existingApiKey = (existing.api_key as string) || ""
      const existingApiSecret = (existing.api_secret as string) || ""
      if (existingApiKey !== apiKey || existingApiSecret !== apiSecret) {
        updates.api_key = apiKey
        updates.api_secret = apiSecret
        updates.updated_at = now
        didChange = true
        credentialsInjected++
      }
    }

    if (Object.keys(updates).length > 0) {
      await client.hset(`connection:${cfg.id}`, updates)
    }
    // Always re-assert index membership; HSET above doesn't manage it.
    await client.sadd("connections", cfg.id)

    if (didChange) createdOrUpdated++
  }

  // ── Global engine status: intentionally NOT bootstrapped ──────────
  // AUTO-START DISABLED: this block previously wrote
  // `trade_engine:global.status = "running"` on every cold boot / redeploy
  // (unless operator_stopped was set), which auto-started all enabled
  // connections without operator action. The engine now starts ONLY when
  // the operator explicitly clicks Start (POST /api/trade-engine/start).
  // On a fresh DB the hash stays empty and the auto-start monitor's sweep
  // simply no-ops until the operator starts the engine.

  // ── Boot guards (run once per process boot) ───────────────────────────
  // ensureBaseConnections() is called once per boot from completeStartup,
  // but the BASE_CONNECTION_CONFIG loop above iterates 6 connections and
  // calls continue early so the code AFTER the loop runs once. Guard with
  // a process-level flag to be safe.
  const _g = globalThis as Record<string, unknown>
  if (_g.__v0_devBootGuardDone) return { createdOrUpdated, credentialsInjected }
  _g.__v0_devBootGuardDone = true
  //
  // 1. ENFORCE SYMBOL COUNT on bingx-x01.
  //    V0_DEV_SYMBOL_COUNT controls how many symbols to use (default 4).
  //    When set to 1 we pin force_symbols=["BTCUSDT"] as the cheapest safe
  //    fixture. When set to N>1 we write symbol_count=N and symbol_order=
  //    volatility_1h so getSymbols() resolves the top-N dynamically.
  //
  //    Migration 057 / 055 may run before this guard and write their own
  //    symbol_count — this runs AFTER all migrations so it always wins.
  //
  // 2. PURGE stale live:position:* keys from a previous run.
  //    The snapshot persists open/placed positions across restarts. Stale
  //    position hashes consume heap, raise fill-detect null-error count,
  //    and inflate the memory guard baseline. Purging here keeps baseline clean.
  {
    const DEV_CONN  = "bingx-x01"
    const devSymCount = Math.max(1, parseInt(process.env.V0_DEV_SYMBOL_COUNT ?? "4", 10) || 4)
    // All key namespaces that getSymbols() reads.
    const devHashes = [
      `connection:${DEV_CONN}`,
      `settings:trade_engine_state:${DEV_CONN}`,
      `settings:connection_settings:${DEV_CONN}`,
      `settings:connection:${DEV_CONN}`,
    ]

    let devSymPayload: Record<string, string>
    if (devSymCount === 1) {
      // Fast path: pin BTCUSDT — no API call needed, cheapest possible boot.
      const DEV_SYM = "BTCUSDT"
      devSymPayload = {
        force_symbols:            JSON.stringify([DEV_SYM]),
        symbol_count:             "1",
        symbol_order:             "",   // disable dynamic fetch
        symbols:                  JSON.stringify([DEV_SYM]),
        active_symbols:           JSON.stringify([DEV_SYM]),
        config_set_symbols_total: "1",
      }
    } else {
      // Multi-symbol path: clear force_symbols so getSymbols() resolves
      // dynamically via volatility_1h, then slices to devSymCount.
      devSymPayload = {
        force_symbols:            "",                       // cleared — getSymbols() falls through
        symbol_count:             String(devSymCount),
        symbol_order:             "volatility_1h",
        symbols:                  "",                       // cleared — engine will repopulate
        active_symbols:           "",
        config_set_symbols_total: String(devSymCount),
      }
    }
    for (const h of devHashes) {
      await client.hset(h, devSymPayload).catch(() => 0)
    }

    // Purge stale live:position:* (open/placed/closed position hashes from
    // the last run). InlineLocalRedis exposes client.keys(pattern) for
    // glob-style matching — use that instead of SCAN (not implemented).
    const livePositionKeys: string[] = await client.keys("live:position:*").catch(() => [])
    let purged = 0
    for (const k of livePositionKeys) {
      // Keep tracking-pointer keys (plain strings, tiny) — only delete
      // the position hash/string keys that carry the full position payload.
      if (!k.includes(":tracking:")) {
        await client.del(k).catch(() => 0)
        purged++
      }
    }

    // CRITICAL: Also purge the open-index and closed-index LISTS for every
    // connection. These lists contain position IDs from the previous run.
    // After purging position hashes above, these IDs are dangling references —
    // getLivePositions() fetches each ID and gets null (deleted hash), which
    // the sync-tick then treats as a terminal position stuck in the open index.
    // Clearing both lists on boot prevents this every-cycle purge noise.
    const posIndexKeys: string[] = await client.keys("live:positions:*").catch(() => [])
    let indexPurged = 0
    for (const k of posIndexKeys) {
      await client.del(k).catch(() => 0)
      indexPurged++
    }

    // CRITICAL: Purge live:lock:* dedup keys from the previous run.
    // These locks have a 5-minute TTL. If the server restarts before TTL
    // expires, the position hashes are deleted (above) but the lock keys
    // survive. The next dispatch for that symbol+direction tries to acquire,
    // gets null (lock held), looks for an existing open position (finds none —
    // it was deleted), and returns "rejected". Every subsequent signal defers
    // for 5 minutes until the TTL expires. Purging at boot ensures a clean
    // slate so the first cycle can place real orders immediately.
    const lockKeys: string[] = await client.keys("live:lock:*").catch(() => [])
    for (const k of lockKeys) {
      await client.del(k).catch(() => 0)
    }

    const symDesc = devSymCount === 1 ? "force_symbols=BTCUSDT" : `symbol_count=${devSymCount} (volatility_1h)`
    console.log(
      `[v0] [Boot] Pinned ${symDesc} across all key namespaces` +
      (purged > 0 ? `, purged ${purged} stale live:position keys` : "") +
      (indexPurged > 0 ? `, cleared ${indexPurged} stale position index lists` : "") +
      (lockKeys.length > 0 ? `, released ${lockKeys.length} stale dedup locks` : ""),
    )
  }

  return { createdOrUpdated, credentialsInjected }
}

// Per-process set of one-shot diagnostic messages already emitted by
// `ensureBaseConnections`. Avoids log spam when migrations run on every
// HTTP request due to module reload (HMR / cold-warm).
const ensureBootstrapDiag = new Set<string>()

/**
 * PRODUCTION MODE COMPLETE COVERAGE REPAIR
 * 
 * This function is the "make sure everything is correct and non-zero in production"
 * pass. It is ALWAYS executed (even when schema is already at latest) when
 * running in production / Vercel preview / prod deploys.
 * 
 * It guarantees:
 *  - All migration-022 style indexes and progression containers exist
 *  - Progression counters, strategy sets, live-position indexes are repaired
 *  - trade_engine:global is bootstrapped to "running" (unless operator stopped)
 *  - Zero-count metadata keys are initialized for every enabled connection
 *  - No "No Progress / No counts" after cold start / redeploy
 * 
 * Dev mode intentionally skips the heavy parts (see startPersistence comments).
 */
async function ensureCompleteProductionCoverage(client: any): Promise<void> {
  // ── Essential progression repair (runs in all modes) ────────────────
  try {
    const allConns = (await client.smembers("connections")) || []
    const connSet = new Set(allConns)

    for (const connId of connSet) {
      if (!connId) continue
      const prefixes = [
        `strategies:${connId}`,
        `progression:${connId}`,
        `live_positions:${connId}`,
        `realtime:${connId}`,
      ]
      for (const p of prefixes) {
        const metaKey = `${p}:metadata`
        if (!(await client.exists(metaKey))) {
          await client.hset(metaKey, {
            created_at: new Date().toISOString(),
            last_cycle: new Date().toISOString(),
            total_base_created: "0",
            total_main_created: "0",
            total_real_created: "0",
            total_live_created: "0",
            repaired_by: "ensureCompleteProductionCoverage",
          })
        }
      }

      // Canonical prehistoric/progression containers for BOTH dev and prod.
      // Seed only pending/zero fields when absent — never stamp completion gates.
      // This makes fresh installs and flushed DBs render a complete progress shape
      // before the engine starts, while preserving the rule that only the real
      // prehistoric pipeline can write :done / :firstpass:done / is_complete=1.
      const prehistoricKey = `prehistoric:${connId}`
      const preExists = await client.exists(prehistoricKey).catch(() => 0)
      if (!preExists) {
        await client.hset(prehistoricKey, {
          is_complete: "0",
          symbols_processed: "0",
          symbols_total: "0",
          candles_loaded: "0",
          indicators_calculated: "0",
          data_source: "pending",
          repaired_by: "ensureCompleteProductionCoverage",
          updated_at: new Date().toISOString(),
        }).catch(() => {})
      }
      await client.hset(`progression:${connId}`, {
        migration_coverage_checked_at: new Date().toISOString(),
      }).catch(() => {})

      // DO NOT stamp prehistoric:done / firstpass:done here.
      // These gates are written by the engine itself after a genuine prehistoric
      // run completes. Stamping them unconditionally on every coverage-repair call
      // (which fires on EVERY migration fast-path invocation = every request)
      // silently skips prehistoric processing for every new/reset connection and
      // directly prevents the "settings change → progression restarts" behaviour.
      // The engine-manager's error path already writes both flags as a safety net
      // when prehistoric genuinely fails.

      // DO NOT stamp engine_started:true here.
      // That flag is the engine's own heartbeat marker. Writing it in the coverage
      // repair resurrects zombie progressions (connections that were stopped/disabled)
      // and fights with the operator-stop path. Only the engine itself sets it.
    }
  } catch (err) {
    console.warn("[v0] [Migrations] Essential progression repair warning:", err)
  }

  console.log("[v0] [Migrations] Running full coverage repair (containers, indexes, global zeros)")

  // Ensure the entire Site/Project has ONE unique instance (independent of connections).
  // IMPORTANT: do not call redis-db.ensureUniqueSiteInstance() from inside
  // migrations; that helper calls initRedis(), and initRedis is currently
  // awaiting runMigrations(), causing a startup deadlock. Use the already-open
  // core Redis client passed to this repair function.
  try {
    const siteKey = "site:unique_instance"
    const existing = await client.hgetall(siteKey).catch(() => null)
    if (!existing || !existing.site_session_id) {
      await client.hset(siteKey, {
        site_session_id: `site_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`,
        created_at: new Date().toISOString(),
        last_activity: new Date().toISOString(),
        page_instance_count: "0",
        initialized_by: "migration_coverage",
      })
    } else {
      await client.hset(siteKey, { last_activity: new Date().toISOString() })
    }
  } catch {}

  try {
    // 1. Global engine status: intentionally NOT bootstrapped.
    // AUTO-START DISABLED: this block previously force-set
    // trade_engine:global.status="running" on every prod request, which
    // auto-started the engine after every deploy. The engine now starts
    // ONLY via the operator's explicit Start action.

    // 2. Get all enabled connections and force-create/repair their progression + strategy containers
    const enabledConns = (await client.smembers("connections:main:enabled")) || []
    const allConns = (await client.smembers("connections")) || []
    const connSet = new Set([...enabledConns, ...allConns])

    for (const connId of connSet) {
      if (!connId) continue

      // Progression containers (the source of "progress" and counts in dashboard)
      const prefixes = [
        `strategies:${connId}`,
        `progression:${connId}`,
        `live_positions:${connId}`,
        `realtime:${connId}`,
      ]
      for (const p of prefixes) {
        const metaKey = `${p}:metadata`
        const exists = await client.exists(metaKey)
        if (!exists) {
          await client.hset(metaKey, {
            created_at: new Date().toISOString(),
            last_cycle: new Date().toISOString(),
            total_base_created: "0",
            total_main_created: "0",
            total_real_created: "0",
            total_live_created: "0",
            repaired_by: "ensureCompleteProductionCoverage",
          })
        }
      }

      // Strategy counters that the UI and engine read for "counts"
      const counters = [
        `strategy_count:${connId}`,
        `real_pi_acc:${connId}`,
        `axis_pos_acc:${connId}`,
        `strategies:${connId}:indices`,
      ]
      for (const c of counters) {
        const ex = await client.exists(c)
        if (!ex) {
          await client.hset(c, "_initialized", "1", "count", "0")
        }
      }

      // Live position indexes (prevents "0 live positions" after restart)
      const liveIdx = `live:positions:${connId}:open`
      if (!(await client.exists(liveIdx))) {
        await client.sadd(liveIdx, "__init__") // empty set marker (code ignores it)
        await client.srem(liveIdx, "__init__")
      }

      // Ensure per-connection engine status keys exist.
      // AUTO-START DISABLED: seed as "stopped" — the coordinator flips it to
      // "running" only when the engine is actually started by the operator.
      const engineStatusKey = `trade_engine:status:${connId}`
      if (!(await client.exists(engineStatusKey))) {
        await client.hset(engineStatusKey, {
          status: "stopped",
          last_tick: new Date().toISOString(),
          cycles: "0",
        })
      }

      // DATA INTEGRITY FIX: synthetic strategy-set counts REMOVED.
      // This block previously wrote fake random counts (180+rand per symbol)
      // into strategies:{conn}:{sym}:{stage}:sets AND unconditionally
      // overwrote the canonical progression hash totals
      // (strategies_base_total etc.) with fabricated numbers on EVERY prod
      // request — clobbering the real engine counters and faking
      // engine_started=true. All counts are now produced exclusively by the
      // real engine pipeline; empty containers start at zero.
    }

    // 3. Global zero-count safety nets + extra coordination keys (Dev has these after first run)
    const globalZeros = [
      "trades:counter:open", "trades:counter:closed",
      "positions:counter:open", "positions:counter:closed",
      "strategies:counter:active", "strategies:counter:paused",
      "logs:system:counter", "logs:trades:counter", "logs:errors:counter",
      "_migration_total_runs",
      "global_engine_cycles", "global_indications_generated",
    ]
    for (const z of globalZeros) {
      const val = await client.get(z)
      if (val == null) {
        await client.set(z, "0")
      }
    }

    // Extra global coordination structures that long-running Dev always has
    await client.hset("system:coordination", {
      last_global_tick: new Date().toISOString(),
      active_connections: String(connSet.size),
      site_instance: "production",
    }).catch(() => {})

    // 4. PREHISTORIC STRUCTURES (containers only — no fake completion).
    // DATA INTEGRITY FIX: this block previously stamped fake prehistoric
    // completion (prehistoric_done=1, 125000 candles, 850 indications, …)
    // unconditionally on every prod request. That faked dashboard data AND
    // skipped the real prehistoric processing phase. Now only the empty
    // container meta keys are ensured; all progress/completion flags are
    // written exclusively by the real prehistoric pipeline
    // (config-set-processor / progression-state-manager).
    for (const connId of connSet) {
      if (!connId) continue
      const prehistoricPrefixes = [
        `strategies:${connId}:prehistoric`,
        `indications:${connId}:prehistoric`,
        `prehistoric:${connId}:data`,
      ]
      for (const p of prehistoricPrefixes) {
        const exists = await client.exists(`${p}:meta`)
        if (!exists) {
          await client.hset(`${p}:meta`, {
            initialized: "1",
            repaired_by: "ensureCompleteProductionCoverage",
            created_at: new Date().toISOString(),
          }).catch(() => {})
        }
      }
      if (!(await client.exists(`prehistoric:${connId}`).catch(() => 0))) {
        await client.hset(`prehistoric:${connId}`, {
          is_complete: "0",
          symbols_processed: "0",
          symbols_total: "0",
          candles_loaded: "0",
          indicators_calculated: "0",
          data_source: "pending",
          repaired_by: "ensureCompleteProductionCoverage",
          updated_at: new Date().toISOString(),
        }).catch(() => {})
      }
    }

    // Ensure uniqueness/solidity snapshot fields exist on progression hashes (for the new per-progress isolation)
    for (const connId of connSet) {
      const progKey = `progression:${connId}`
      const hasSnapshot = await client.hget(progKey, "progress_settings_snapshot").catch(() => null)
      if (!hasSnapshot) {
        await client.hset(progKey, {
          symbol_count: "0",
          active_symbols_hash: "",
          started_for_settings_version: new Date().toISOString(),
          progress_settings_snapshot: JSON.stringify({ initialized_by: "prod_coverage", at: new Date().toISOString() }),
        }).catch(() => {})
      }
    }

    // (No fake position seeding — positions are created exclusively by the
    // live-trade engine when real orders fill on the exchange.)

    console.log(`[v0] [Migrations] [PROD-COVERAGE] Complete coverage repair finished for ${connSet.size} connections (prehistoric containers + logistics + per-progress uniqueness; no fake completion/live positions)`)
  } catch (err) {
    console.warn("[v0] [Migrations] [PROD-COVERAGE] Repair pass had non-fatal error (continuing):", err)
  }
}

function createMigrationExecutionClient(client: any): any {
  return new Proxy(client, {
    get(target, prop, receiver) {
      if (prop === "set") {
        return async (key: string, value: unknown, ...args: unknown[]) => {
          if (key === "_schema_version") {
            return "OK"
          }
          return target.set(key, value, ...args)
        }
      }
      const value = Reflect.get(target, prop, receiver)
      return typeof value === "function" ? value.bind(target) : value
    },
  })
}

async function runPendingMigrationBatch({
  client,
  pendingMigrations,
  deadlineMs,
}: {
  client: any
  pendingMigrations: Migration[]
  deadlineMs: number
}): Promise<void> {
  const migrationClient = createMigrationExecutionClient(client)
  const startedAt = Date.now()

  for (const migration of pendingMigrations) {
    const elapsed = Date.now() - startedAt
    const remainingMs = Math.max(1, deadlineMs - elapsed)
    let timeout: ReturnType<typeof setTimeout> | undefined
    try {
      console.log(`[v0] [Migrations] Running: ${migration.name} (v${migration.version})`)
      await Promise.race([
        migration.up(migrationClient),
        new Promise<never>((_, reject) => {
          timeout = setTimeout(
            () => reject(new Error(`Migration ${migration.name} exceeded remaining batch deadline (${remainingMs}ms)`)),
            remainingMs,
          )
        }),
      ]).finally(() => {
        if (timeout) clearTimeout(timeout)
      })
      // Stamp `_schema_version` after EACH migration from the runner. Individual
      // migration bodies often contain legacy `_schema_version` writes; the
      // proxy above suppresses those duplicate writes so fresh installs execute
      // as one optimized batch while retaining crash/restart-safe step progress.
      await client.set("_schema_version", migration.version.toString())
      console.log(`[v0] [Migrations] ✓ Completed: ${migration.name} (schema now v${migration.version})`)
    } catch (error) {
      console.error(`[v0] [Migrations] ✗ Failed during ${migration.name}:`, error)
      throw error
    }
  }
}

/**
 * Run all pending migrations
 */
export async function runMigrations(): Promise<{ success: boolean; message: string; version: number }> {
  // If a run is already in-flight (or completed), return the same promise so
  // concurrent callers coalesce onto a single execution and never re-enter
  // runMigrationsInternal(). The promise is intentionally kept after resolution —
  // clearing it in `finally` caused a race where a second caller that had just
  // started awaiting would see null and immediately start a second migration run.
  const existing = getMigrationRunPromise()
  if (existing) {
    return existing
  }

  const promise = runMigrationsInternal()
  setMigrationRunPromise(promise)
  void promise.catch(() => {
    // Do not cache a rejected migration promise forever. initRedis() also
    // resets this state on migration errors, but runMigrations() is exported
    // and can be called directly by admin/maintenance routes. If a direct call
    // hits a transient Redis error or per-migration deadline, the next caller
    // must be able to retry instead of receiving the same stale rejection.
    if (getMigrationRunPromise() === promise) {
      setMigrationRunPromise(null)
    }
  })
  return promise
}

async function runMigrationsInternal(): Promise<{ success: boolean; message: string; version: number }> {
  try {
    // Check if migrations have already run in this process
    if (haveMigrationsRun()) {
      const finalVer = Math.max(...migrations.map((m) => m.version))
      await ensureCoreRedis()
      const client = getRedisClient()

      // Keep process guard synced with persisted migration state.
      const persistedRunState = await client.get("_migrations_run")
      if (persistedRunState !== "true") {
        await client.set("_migrations_run", "true")
      }

      // ── CRITICAL: Check for NEW pending migrations added via code change ──
      // Previous implementation: the `haveMigrationsRun()` guard short-circuited
      // and always returned "Already run in this process" without checking Redis
      // `_schema_version`. If NEW migrations (e.g. migration 041) were added to
      // the codebase via hot-reload, they NEVER ran because the process flag was
      // already true. Now: always verify Redis is at the latest code version, and
      // if not, fall through to the normal pending-migration path below.
      const versionStr = await client.get("_schema_version")
      const currentVersion = versionStr ? parseInt(versionStr as string) : 0
      if (currentVersion < finalVer) {
        // New migrations exist that haven't run yet — clear the process guard
        // and fall through to the full run path below.
        setMigrationsRun(false)
        console.log(`[v0] [Migrations] Hot-reload detected new migrations: Redis v${currentVersion} < code v${finalVer}`)
      } else {
        // Redis is at latest — fast-path return.
        const ensured = await ensureBaseConnections(client)
        // Only log when something actually changed; otherwise the "ensured=0,
        // credentialsInjected=0" line spams every HTTP request because the
        // migration loader runs on every module reload (HMR / cold-warm).
        if (ensured.createdOrUpdated > 0 || ensured.credentialsInjected > 0) {
          console.log(
            `[v0] [Migrations] ✓ Already executed in this process; ` +
              `base ensured=${ensured.createdOrUpdated}, credentialsInjected=${ensured.credentialsInjected}`,
          )
        }

        // Coverage repair runs at most ONCE per process (one-shot guard on
        // globalThis). On every subsequent fast-path call (= every API request)
        // we skip it entirely — it iterates all connections and was the primary
        // cause of slow startup on repeated requests.
        if (!globalMigrationGuard.__coverage_repair_done) {
          globalMigrationGuard.__coverage_repair_done = true
          await ensureCompleteProductionCoverage(client)
        }

        return { success: true, message: "Already run in this process", version: finalVer }
      }
    }

    await ensureCoreRedis()
    const client = getRedisClient()

     const persistedRunState = await client.get("_migrations_run")
     if (persistedRunState === "true") {
       await setMigrationsRun(true)
     }

    const versionStr = await client.get("_schema_version")
    const currentVersion = versionStr ? parseInt(versionStr as string) : 0
    const finalVersion = Math.max(...migrations.map((m) => m.version))

    console.log(`[v0] [Migrations] Current: v${currentVersion}, Target: v${finalVersion}`)

    // Get migrations that need to run (version > currentVersion)
    const pendingMigrations = migrations.filter((m) => m.version > currentVersion)
    
    if (pendingMigrations.length === 0) {
      // Suppress the "already at latest" line after the first occurrence
      // in this process ��� it fires on every module reload and contributes
      // most of the log noise during normal operation.
      if (!ensureBootstrapDiag.has("already_latest")) {
        ensureBootstrapDiag.add("already_latest")
        console.log(`[v0] [Migrations] Already at latest version ${finalVersion}`)
      }
      const ensured = await ensureBaseConnections(client)
      // Only log when something actually changed (see same-pattern note above).
      if (ensured.createdOrUpdated > 0 || ensured.credentialsInjected > 0) {
        console.log(
          `[v0] [Migrations] ✓ Ensured ${ensured.createdOrUpdated} base connections; ` +
            `injected credentials for ${ensured.credentialsInjected}`,
        )
      }
       await setMigrationsRun(true)

      // Coverage repair: once per process only (same guard as the fast-path above).
      if (!globalMigrationGuard.__coverage_repair_done) {
        globalMigrationGuard.__coverage_repair_done = true
        await ensureCompleteProductionCoverage(client)
      }

      return { success: true, message: `Already at latest version ${finalVersion}`, version: finalVersion }
    }

    // Run pending migrations as one optimized batch. The batch client suppresses
    // duplicate legacy `_schema_version` writes inside individual migration
    // bodies; this runner remains the single place that stamps durable per-step
    // progress after each migration completes.
    const MIGRATION_DEADLINE_MS = Math.max(30_000, pendingMigrations.length * 30_000)
    console.log(`[v0] [Migrations] Running ${pendingMigrations.length} pending migrations as a combined batch...`)
    await runPendingMigrationBatch({ client, pendingMigrations, deadlineMs: MIGRATION_DEADLINE_MS })

    // Ensure schema version reflects the final target (defensive; the loop
    // already stamped the last migration's version).
    await client.set("_schema_version", finalVersion.toString())
    
    // Track migration runs
    const runCount = await client.get("_migration_total_runs")
    const newRunCount = (parseInt((runCount as string) || "0") + 1).toString()
    await client.set("_migration_total_runs", newRunCount)
    await client.set("_migration_last_run", new Date().toISOString())

    console.log(`[v0] [Migrations] ✓ Successfully migrated v${currentVersion} -> v${finalVersion}`)
    console.log(`[v0] [Migrations] ${pendingMigrations.length} migrations executed`)
    
    // Verify final state
    const finalVersionCheck = await client.get("_schema_version")
    console.log(`[v0] [Migrations] ✓ Verification: Schema version is now ${finalVersionCheck}`)
    
    const ensured = await ensureBaseConnections(client)
    console.log(`[v0] [Migrations] ✓ Ensured ${ensured.createdOrUpdated} base connections; injected credentials for ${ensured.credentialsInjected}`)
    
     // Mark migrations as run in this process
     await setMigrationsRun(true)

    // PRODUCTION: INTENSIVE coverage after migrations (no holes, complete processings)
    await ensureCompleteProductionCoverage(client)
    
    return { success: true, message: `Migrated from v${currentVersion} to v${finalVersion}`, version: finalVersion }
  } catch (error) {
    console.error("[v0] [Migrations] ✗ Migration failed:", error)
    throw error
  }
}

/**
 * Rollback to previous migration
 */
export async function rollbackMigration(): Promise<void> {
  try {
    await ensureCoreRedis()
    const client = getRedisClient()
    const versionStr = await client.get("_schema_version")
    const currentVersion = versionStr ? parseInt(versionStr as string) : 0
    if (currentVersion === 0) {
      console.log("[v0] No migrations to rollback")
      return
    }
    const migrationToRollback = migrations.find((m) => m.version === currentVersion)
    if (migrationToRollback) {
      console.log(`[v0] Rolling back: ${migrationToRollback.name}`)
      await migrationToRollback.down(client)
    }
    console.log(`[v0] Rolled back to version ${currentVersion - 1}`)
  } catch (error) {
    console.error("[v0] Rollback failed:", error)
    throw error
  }
}

/**
 * Get migration status
 */
export async function getMigrationStatus(): Promise<any> {
  try {
    await ensureCoreRedis()
    const client = getRedisClient()
    const versionStr = await client.get("_schema_version")
    const currentVersion = versionStr ? parseInt(versionStr as string) : 0
    const latestVersion = Math.max(...migrations.map((m) => m.version))
    return {
      currentVersion,
      latestVersion,
      isMigrated: currentVersion === latestVersion,
      pendingMigrations: migrations.filter((m) => m.version > currentVersion),
      message: currentVersion === latestVersion
        ? `Already at latest version ${currentVersion}`
        : `${latestVersion - currentVersion} pending migrations`,
    }
  } catch (error) {
    console.error("[v0] Could not get migration status:", error)
    return {
      currentVersion: 0,
      latestVersion: Math.max(...migrations.map((m) => m.version)),
      isMigrated: false,
      message: "Failed to check status",
      error: error instanceof Error ? error.message : "Unknown error",
    }
  }
}
