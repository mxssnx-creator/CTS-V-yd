import { NextResponse } from "next/server"
import { initRedis, getRedisClient, isRedisConnected, getConnectionCountDiagnostics } from "@/lib/redis-db"

export const dynamic = "force-dynamic"

export async function GET() {
  try {
    await initRedis()
    const client = getRedisClient()
    const connected = isRedisConnected()
    
    let connectionCount = 0
    let connectionCounts = { connection_hash_count: 0, legacy_connection_set_count: 0 }
    let schemaVersion = "0"
    
    if (connected) {
      connectionCounts = await getConnectionCountDiagnostics()
      connectionCount = connectionCounts.connection_hash_count
      schemaVersion = (await client.get("_schema_version") || "0") as string
    }

    const kvUrl = process.env.KV_REST_API_URL || ""
    const maskedUrl = kvUrl ? `redis://*****@${new URL(kvUrl).host}` : "redis://connected"

    return NextResponse.json({
      type: "redis",
      isConfigured: connected,
      isConnected: connected,
      url: maskedUrl,
      tableCount: connectionCount,
      connection_hash_count: connectionCounts.connection_hash_count,
      legacy_connection_set_count: connectionCounts.legacy_connection_set_count,
      schemaVersion: parseInt(schemaVersion),
      envVars: {
        KV_REST_API_URL: !!process.env.KV_REST_API_URL,
        KV_REST_API_TOKEN: !!process.env.KV_REST_API_TOKEN,
      },
    })
  } catch (error) {
    console.error("[v0] Failed to get database status:", error)
    return NextResponse.json(
      {
        type: "redis",
        isConfigured: false,
        isConnected: false,
        error: error instanceof Error ? error.message : "Unknown error",
      },
      { status: 500 },
    )
  }
}
