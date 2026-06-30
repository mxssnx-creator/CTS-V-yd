import { NextResponse } from "next/server"
import { initRedis, getRedisClient } from "@/lib/redis-db"
import { getMigrationStatus } from "@/lib/redis-migrations"

export const dynamic = "force-dynamic"
export async function GET() {
  try {
    await initRedis()
    
    // Get actual migration status from database
    const migrationStatus = await getMigrationStatus()
    const client = getRedisClient()
    
    // Count total keys using scard for connections set
    let keyCount = 0
    try {
      const connectionsCount = await (client as any).scard("connections")
      keyCount = connectionsCount || 0
    } catch (e) {
      console.warn("[v0] Failed to count connections")
      keyCount = 0
    }
    
    return NextResponse.json({
      status: "success",
      is_installed: migrationStatus.latestVersion >= 1,
      database_connected: true,
      database_type: "redis",
      table_count: keyCount,
      migrations: {
        current_version: migrationStatus.currentVersion,
        applied: migrationStatus.currentVersion,
        pending: migrationStatus.pendingMigrations?.length ?? Math.max(0, migrationStatus.latestVersion - migrationStatus.currentVersion),
      },
      database_stats: {
        connected: true,
        mode: "redis",
        total_keys: keyCount,
        is_fallback: false,
      },
      migration_status: {
        latest_version: migrationStatus.latestVersion,
        is_up_to_date: migrationStatus.message.includes("latest"),
        message: migrationStatus.message,
      }
    })
  } catch (error) {
    console.error("[v0] Status check error:", error)
    return NextResponse.json({
      status: "error",
      message: error instanceof Error ? error.message : "Failed to get database status",
      is_installed: false,
      database_connected: false,
      migrations: {
        current_version: 0,
        applied: 0,
        pending: 11,
      }
    }, { status: 500 })
  }
}
