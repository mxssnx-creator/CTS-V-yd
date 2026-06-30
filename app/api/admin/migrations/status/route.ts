import { NextResponse } from "next/server"
import { initRedis, getRedisClient, getConnectionCountDiagnostics } from "@/lib/redis-db"

import { getMigrationStatus } from "@/lib/redis-migrations"

export const dynamic = "force-dynamic"

/**
 * Get migration status - Redis version
 * GET /api/admin/migrations/status
 */
export async function GET() {
  try {
    await initRedis()
    const client = getRedisClient()
    const migrationStatus = await getMigrationStatus()
    
    // Check key patterns in Redis to determine what data exists
    const connectionCounts = await getConnectionCountDiagnostics()
    const connectionCount = connectionCounts.connection_hash_count
    const schemaVersion = await client.get("_schema_version") || "0"
    
    return NextResponse.json({
      success: true,
      database: {
        type: "redis",
        connected: true
      },
      migrations: {
        schemaVersion: parseInt(schemaVersion as string),
        status: migrationStatus
      },
      data: {
        connections: connectionCount,
        connection_hash_count: connectionCounts.connection_hash_count,
        legacy_connection_set_count: connectionCounts.legacy_connection_set_count,
      },
      status: "complete",
      timestamp: new Date().toISOString()
    })
  } catch (error) {
    console.error("[v0] Migration status check failed:", error)
    return NextResponse.json({
      success: false,
      error: error instanceof Error ? error.message : "Unknown error",
      timestamp: new Date().toISOString()
    }, { status: 500 })
  }
}
