import { NextResponse } from "next/server"
import { initRedis, getRedisClient, isRedisConnected, getRedisBackend } from "@/lib/redis-db"

export const dynamic = "force-dynamic"
export async function GET() {
  try {
    await initRedis()
    const client = getRedisClient()
    const connected = isRedisConnected()
    
    const connectionCount = connected ? await client.scard("connections") : 0
    const schemaVersion = connected ? (await client.get("_schema_version") || "0") : "0"
    
    return NextResponse.json({
      isInstalled: connected && connectionCount > 0,
      databaseType: "redis",
      databaseConnected: connected,
      redisBackend: getRedisBackend(),
      tablesExist: connectionCount > 0,
      tableCount: connectionCount,
      hasMigrations: true,
      migrationsApplied: parseInt(schemaVersion as string),
      error: !connected ? "Redis not connected" : null,
    })
  } catch (error) {
    return NextResponse.json({
      isInstalled: false,
      databaseType: "redis",
      databaseConnected: false,
      tablesExist: false,
      tableCount: 0,
      migrationsApplied: 0,
      error: error instanceof Error ? error.message : "Failed to check install status",
    })
  }
}
