import { NextResponse } from "next/server"
import { initRedis, verifyRedisHealth, getAllConnections, getRedisClient, getSettings } from "@/lib/redis-db"
import { healthCheckService } from "@/lib/health-check"

export const dynamic = "force-dynamic"

export async function GET() {
  try {
    console.log("[HEALTH] Full health check initiated...")

    // Use new health check service
    const report = await healthCheckService.getHealthReport()

    // Also get legacy metrics for backward compatibility
    const redisHealthy = await verifyRedisHealth()
    if (!redisHealthy) {
      console.error("[HEALTH] Redis health check failed")
      return NextResponse.json({
        ...report,
        status: "degraded",
        alive: true,
        redis: "unhealthy",
        message: "Redis connection is not healthy; readiness is degraded but the web process is alive",
      }, { status: 200 })
    }

    console.log("[HEALTH] Redis health check passed")

    // Get all connections from Redis (cached for 5 seconds)
    const client = getRedisClient()
    const cacheKey = "health:cached_metrics"
    let cachedMetrics = null
    
    try {
      const cached = await client.get(cacheKey)
      if (cached) {
        cachedMetrics = JSON.parse(cached)
        console.log("[HEALTH] Using cached metrics")
      }
    } catch (e) {
      console.warn("[HEALTH] Cache read error (non-fatal):", e)
    }

    let connections = await getAllConnections()
    let runningEngines = 0
    let totalTrades = 0
    let totalPositions = 0

    if (cachedMetrics) {
      // Use cached values
      runningEngines = cachedMetrics.runningEngines
      totalTrades = cachedMetrics.totalTrades
      totalPositions = cachedMetrics.totalPositions
    } else {
      // Compute and cache (expensive operation)
      for (const connection of connections) {
        try {
          const flagKey = `engine_is_running:${connection.id}`
          const flag = await client.get(flagKey)
          const isRunning = flag === "1" || flag === "true"
          if (isRunning) {
            runningEngines++
          }

          const trades = await client.smembers(`trades:${connection.id}`) || []
          const positions = await client.smembers(`positions:${connection.id}`) || []
          totalTrades += trades.length
          totalPositions += positions.length
        } catch (error) {
          console.warn(`[HEALTH] Failed to get metrics for connection ${connection.id}:`, error)
        }
      }
      
      // Cache for 5 seconds
      try {
        await client.setex(cacheKey, 5, JSON.stringify({
          runningEngines,
          totalTrades,
          totalPositions,
        }))
      } catch (e) {
        console.warn("[HEALTH] Cache write error (non-fatal):", e)
      }
    }

    const enabledConnections = connections.filter(c => c.is_enabled)

    const status = report.status || (redisHealthy ? "healthy" : "degraded")
    const response = {
      ...report,
      status,
      timestamp: new Date().toISOString(),
      redis: {
        healthy: true,
        connected: true,
      },
      system: {
        totalConnections: connections.length,
        enabledConnections: enabledConnections.length,
        runningEngines: runningEngines,
        totalTrades: totalTrades,
        totalOpenPositions: totalPositions,
      },
    }

    console.log("[HEALTH] Full health check completed successfully")
    
    // Deployment platforms (Kilo/OpenNext, Docker, and Vercel previews) use
    // this route as a process liveness probe. Do not fail the deployment
    // because Redis/exchange readiness is temporarily degraded during cold
    // start; strict dependency readiness is available at /api/health/readiness.
    return NextResponse.json(response, { status: 200 })
  } catch (error) {
    console.error("[HEALTH] Health check failed:", error)
    return NextResponse.json({
      status: "degraded",
      alive: true,
      redis: "error",
      error: error instanceof Error ? error.message : "Unknown error",
      message: "Health diagnostics failed, but the web process is alive",
    }, { status: 200 })
  }
}
