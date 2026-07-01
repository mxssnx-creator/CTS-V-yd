/**
 * System Status API
 * Returns comprehensive system status including connection, rate limiting, and API health
 */

import { type NextRequest, NextResponse } from "next/server"
import { SystemLogger } from "@/lib/system-logger"
import { ConnectionCoordinator } from "@/lib/connection-coordinator"
import { BatchProcessor } from "@/lib/batch-processor"
import { isTruthyFlag } from "@/lib/boolean-utils"
import { isConnectionReadyForEngine } from "@/lib/connection-state-helpers"

export const dynamic = "force-dynamic"
export async function GET(request: NextRequest) {
  try {
    const coordinator = ConnectionCoordinator.getInstance()
    const batchProcessor = BatchProcessor.getInstance()

    // Production route workers can be cold-started independently from the
    // browser/dev boot path. Hydrate the coordinator from Redis before reading
    // its in-memory maps; otherwise production health/status reports zero
    // connections even though Redis has been migrated and seeded correctly.
    await coordinator.initializeConnections()

    // Get system-wide statistics
    const allConnections = coordinator.getAllConnections()
    const activeConnections = allConnections.filter((c) => isConnectionReadyForEngine(c))
    const allHealth = coordinator.getAllConnectionsHealth()
    const allMetrics = coordinator.getAllConnectionsMetrics()

    // Get database info from Redis
    let databaseInfo: any = { status: "available", type: "redis" }
    try {
      const { getRedisClient } = await import("@/lib/redis-db")
      const client = getRedisClient()
      const dbSize = await client.dbSize()
      databaseInfo = {
        status: "available",
        type: "redis",
        keys_count: dbSize,
      }
    } catch (error) {
      databaseInfo.error = "Redis info unavailable"
    }

    // Group by exchange
    const byExchange: Record<string, number> = {}
    const byApiType: Record<string, number> = {}

    for (const conn of allConnections) {
      byExchange[conn.exchange] = (byExchange[conn.exchange] || 0) + 1
      byApiType[conn.api_type] = (byApiType[conn.api_type] || 0) + 1
    }

    // Calculate metrics
    const totalRequests = allMetrics.reduce((sum, m) => sum + m.totalRequests, 0)
    const successfulRequests = allMetrics.reduce((sum, m) => sum + m.successfulRequests, 0)
    const failedRequests = allMetrics.reduce((sum, m) => sum + m.failedRequests, 0)
    const averageResponseTime = allMetrics.length > 0 ? (allMetrics.reduce((sum, m) => sum + m.averageResponseTime, 0) / allMetrics.length).toFixed(2) : "N/A"

    // Batch processor status
    const batchStatus = batchProcessor.getQueueStatus()

    const systemStatus = {
      timestamp: new Date().toISOString(),
      status: activeConnections.length > 0 ? "healthy" : "degraded",
      database: databaseInfo,
      connections: {
        total: allConnections.length,
        active: activeConnections.length,
        enabled: allConnections.filter((c) => isTruthyFlag(c.is_enabled_dashboard)).length,
        disabled: allConnections.filter((c) => !isTruthyFlag(c.is_enabled_dashboard)).length,
        byExchange,
        byApiType,
      },
      health: {
        healthy: allHealth.filter((h) => h.status === "active").length,
        unhealthy: allHealth.filter((h) => h.status === "error").length,
        testing: allHealth.filter((h) => h.status === "testing").length,
        paused: allHealth.filter((h) => h.status === "paused").length,
        averageUptime: allHealth.length > 0 ? (allHealth.reduce((sum, h) => sum + h.uptime, 0) / allHealth.length).toFixed(2) : "N/A",
      },
      metrics: {
        totalRequests,
        successfulRequests,
        failedRequests,
        successRate: totalRequests > 0 ? ((successfulRequests / totalRequests) * 100).toFixed(2) : "N/A",
        averageResponseTime,
      },
      batch: {
        queueLength: batchStatus.queueLength,
        activeTasks: batchStatus.activeTasks,
        maxConcurrent: batchStatus.maxConcurrent,
        completedTasks: batchStatus.completedTasks,
      },
      apiTypes: {
        supported: ["rest", "websocket", "unified", "perpetual_futures", "spot", "margin"],
        rateLimitingEnabled: true,
        batchProcessingEnabled: true,
        exchangesSupported: [
          "bybit",
          "binance",
          "okx",
          "bingx",
          "pionex",
          "orangex",
        ],
      },
      features: {
        rateLimiting: "enabled",
        batchProcessing: "enabled",
        connectionPooling: "enabled",
        healthMonitoring: "enabled",
        metricsTracking: "enabled",
        autoReconnection: "enabled",
      },
    }

    return NextResponse.json(systemStatus, { status: 200 })
  } catch (error) {
    console.error("[v0] System status error:", error)
    await SystemLogger.logError(error, "api", "GET /api/system/status")

    return NextResponse.json(
      {
        error: "Failed to retrieve system status",
        details: error instanceof Error ? error.message : "Unknown error",
        timestamp: new Date().toISOString(),
      },
      { status: 500 }
    )
  }
}
