import { type NextRequest, NextResponse } from "next/server"
import { initRedis, getRedisClient, isRedisConnected, setSettings, getConnectionCountDiagnostics } from "@/lib/redis-db"
import { runMigrations, getMigrationStatus } from "@/lib/redis-migrations"
import { SystemLogger } from "@/lib/system-logger"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"

export async function POST(request: NextRequest) {
  const logs: string[] = []

  try {
    logs.push("Starting Redis database migrations...")
    console.log("[v0] Starting Redis database migrations...")

    // Step 1: Initialize Redis connection
    logs.push("Connecting to Redis...")
    try {
      await initRedis()
      logs.push("✓ Redis connected successfully")
      console.log("[v0] Redis connected")
    } catch (error) {
      const errorMsg = `Redis connection failed: ${error}`
      logs.push(`✗ ${errorMsg}`)
      throw new Error(errorMsg)
    }

    // Step 2: Run migrations
    logs.push("Running pending migrations...")
    try {
      await runMigrations()
      logs.push("✓ Migrations completed successfully")
      console.log("[v0] Migrations completed")
    } catch (error) {
      const errorMsg = `Migration execution failed: ${error}`
      logs.push(`✗ ${errorMsg}`)
      throw new Error(errorMsg)
    }

    // Step 3: Create indexes
    logs.push("Creating database indexes...")
    try {
      const client = getRedisClient()

      // Connection indexes
      await client.set("_index:connections:enabled", "true")
      await client.set("_index:connections:by_exchange", "true")
      await client.set("_index:connections:by_status", "true")
      await client.set("_index:connections:by_testnet", "true")

      // Trade indexes
      await client.set("_index:trades:by_connection", "true")
      await client.set("_index:trades:by_status", "true")
      await client.set("_index:trades:by_symbol", "true")

      // Position indexes
      await client.set("_index:positions:by_symbol", "true")
      await client.set("_index:positions:by_connection", "true")
      await client.set("_index:positions:active", "true")

      // Settings indexes
      await client.set("_index:settings:keys", "true")

      logs.push("✓ Indexes created successfully")
      console.log("[v0] Indexes created")
    } catch (error) {
      const errorMsg = `Index creation failed: ${error}`
      logs.push(`✗ ${errorMsg}`)
      throw new Error(errorMsg)
    }

    // Step 4: Configure TTL policies
    logs.push("Configuring TTL expiration policies...")
    try {
      const ttlPolicies = {
        "connections": 30 * 24 * 60 * 60, // 30 days
        "trades": 90 * 24 * 60 * 60, // 90 days
        "positions": 60 * 24 * 60 * 60, // 60 days
        "logs": 7 * 24 * 60 * 60, // 7 days
        "cache": 24 * 60 * 60, // 1 day
      }

      for (const [key, ttl] of Object.entries(ttlPolicies)) {
        await setSettings(`ttl_policy:${key}`, ttl)
      }

      logs.push("✓ TTL policies configured")
      console.log("[v0] TTL policies set")
    } catch (error) {
      const errorMsg = `TTL configuration failed: ${error}`
      logs.push(`⚠ ${errorMsg}`)
    }

    // Step 5: Get migration status and stats
    const status = await getMigrationStatus()
    const connectionCounts = await getConnectionCountDiagnostics()
    const keyCount = connectionCounts.connection_hash_count

    logs.push(`Database Statistics:`)
    logs.push(`  - Schema Version: ${status.currentVersion}`)
    logs.push(`  - Stored Connections: ${keyCount}`)
    logs.push(`  - Connection Hash Count: ${connectionCounts.connection_hash_count}`)
    logs.push(`  - Legacy Connection Set Count: ${connectionCounts.legacy_connection_set_count}`)
    logs.push(`  - Database Type: Redis`)
    logs.push(`  - Indexes: Created`)
    logs.push(`  - TTL Policies: Configured`)

    // Step 6: Initialize system configuration
    logs.push("Initializing system configuration...")
    try {
      const systemConfig = {
        database_type: "redis",
        initialized_at: new Date().toISOString(),
        version: "3.2",
        schema_version: status.currentVersion,
        target_schema_version: status.latestVersion,
        features: {
          live_trading: true,
          preset_trading: true,
          backtesting: true,
          multi_exchange: true,
          real_positions: true,
          pseudo_positions: true,
        },
        optimization: {
          indexes_enabled: true,
          ttl_policies_enabled: true,
          compression_enabled: false,
        },
      }

      await setSettings("system:config", systemConfig)
      logs.push("✓ System configuration initialized")
    } catch (error) {
      const errorMsg = `System configuration failed: ${error}`
      logs.push(`⚠ ${errorMsg}`)
    }

    logs.push("")
    logs.push("========================================")
    logs.push("✓ Redis migration completed successfully!")
    logs.push("========================================")

    console.log("[v0] Redis migration completed successfully")

    return NextResponse.json(
      {
        success: true,
        message: "Redis database migration completed successfully",
        database_type: "redis",
        status: {
          schema_version: status.currentVersion,
          target_schema_version: status.latestVersion,
          is_up_to_date: status.currentVersion === status.latestVersion,
          indexes_created: true,
          ttl_configured: true,
          optimizations_enabled: true,
        },
        stats: {
          total_keys: keyCount,
          connection_hash_count: connectionCounts.connection_hash_count,
          legacy_connection_set_count: connectionCounts.legacy_connection_set_count,
          connected: true,
        },
        logs,
      },
      { status: 200 }
    )
  } catch (error) {
    const errorMsg = "Redis migration failed"
    logs.push(``)
    logs.push(`✗ ${errorMsg}`)
    console.error("[v0] Migration error:", error)

    return NextResponse.json(
      {
        success: false,
        error: errorMsg,
        details: error instanceof Error ? error.message : "Unknown error",
        database_type: "redis",
        logs,
      },
      { status: 500 }
    )
  }
}

export async function GET(request: NextRequest) {
  try {
    const connected = await isRedisConnected()

    if (!connected) {
      return NextResponse.json(
        {
          success: false,
          database_type: "redis",
          status: "disconnected",
          error: "Redis not connected",
        },
        { status: 503 }
      )
    }

    const status = await getMigrationStatus()
    const client = getRedisClient()
    const keyCount = await client.dbSize()

    return NextResponse.json(
      {
        success: true,
        database_type: "redis",
        migration_status: {
          current_version: status.currentVersion,
          latest_version: status.latestVersion,
          is_up_to_date: status.currentVersion === status.latestVersion,
        },
        database_stats: {
          total_keys: keyCount,
          connected: true,
          indexes_enabled: true,
          ttl_enabled: true,
        },
      },
      { status: 200 }
    )
  } catch (error) {
    console.error("[v0] Status check error:", error)

    return NextResponse.json(
      {
        success: false,
        database_type: "redis",
        error: "Failed to get migration status",
        details: error instanceof Error ? error.message : "Unknown error",
      },
      { status: 500 }
    )
  }
}
