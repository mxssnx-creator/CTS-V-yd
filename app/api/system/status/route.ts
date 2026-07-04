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
import { buildMissingTradeEngineWorkerDiagnostic } from "@/lib/trade-engine-worker-heartbeat"

const HEARTBEAT_FRESH_MS = 90_000;

function toNumber(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function isFreshHeartbeat(value: unknown, now = Date.now()): boolean {
  const heartbeatAt = toNumber(value);
  return heartbeatAt > 0 && now - heartbeatAt < HEARTBEAT_FRESH_MS;
}

export const dynamic = "force-dynamic";
export async function GET(request: NextRequest) {
  try {
    const coordinator = ConnectionCoordinator.getInstance();
    const batchProcessor = BatchProcessor.getInstance();

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

    // Get database and runtime heartbeat info from Redis
    let databaseInfo: any = { status: "available", type: "redis" };
    let engineGlobalState: Record<string, string> = {};
    const engineStatesByConnection: Record<string, Record<string, string>> = {};
    try {
      const { getRedisClient } = await import("@/lib/redis-db");
      const client = getRedisClient();
      const [dbSize, globalState, ...connectionStates] = await Promise.all([
        client.dbSize(),
        client
          .hgetall("trade_engine:global")
          .catch(() => ({}) as Record<string, string>),
        ...allConnections.map((conn) =>
          client
            .hgetall(`trade_engine_state:${conn.id}`)
            .catch(() => ({}) as Record<string, string>),
        ),
      ]);
      databaseInfo = {
        status: "available",
        type: "redis",
        keys_count: dbSize,
      };
      engineGlobalState = globalState || {};
      allConnections.forEach((conn, index) => {
        engineStatesByConnection[conn.id] = connectionStates[index] || {};
      });
    } catch (error) {
      databaseInfo.error = "Redis info unavailable";
    }

    let tradeEngineGlobal: Record<string, string> = {}
    try {
      const { getRedisClient } = await import("@/lib/redis-db")
      const client = getRedisClient()
      tradeEngineGlobal = (await client.hgetall("trade_engine:global").catch(() => ({}))) as Record<string, string>
    } catch {}
    const tradeEngineWorkerDiagnostic = buildMissingTradeEngineWorkerDiagnostic(tradeEngineGlobal)

    // Group by exchange
    const byExchange: Record<string, number> = {};
    const byApiType: Record<string, number> = {};

    for (const conn of allConnections) {
      byExchange[conn.exchange] = (byExchange[conn.exchange] || 0) + 1;
      byApiType[conn.api_type] = (byApiType[conn.api_type] || 0) + 1;
    }

    // Calculate metrics
    const totalRequests = allMetrics.reduce(
      (sum, m) => sum + m.totalRequests,
      0,
    );
    const successfulRequests = allMetrics.reduce(
      (sum, m) => sum + m.successfulRequests,
      0,
    );
    const failedRequests = allMetrics.reduce(
      (sum, m) => sum + m.failedRequests,
      0,
    );
    const averageResponseTime =
      allMetrics.length > 0
        ? (
            allMetrics.reduce((sum, m) => sum + m.averageResponseTime, 0) /
            allMetrics.length
          ).toFixed(2)
        : "N/A";

    // Batch processor status
    const batchStatus = batchProcessor.getQueueStatus();

    const now = Date.now();
    const globalOperatorStatus =
      engineGlobalState.operator_intent ||
      engineGlobalState.desired_status ||
      engineGlobalState.status ||
      "stopped";
    const globalHeartbeatAt = toNumber(engineGlobalState.last_heartbeat_at);
    const globalHeartbeatFresh = isFreshHeartbeat(globalHeartbeatAt, now);
    const configuredConnections = allConnections.filter(
      (c) =>
        isTruthyFlag(c.is_enabled) ||
        isTruthyFlag((c as any).is_enabled_dashboard),
    );
    const engineConnections = allConnections.map((conn) => {
      const engineState = engineStatesByConnection[conn.id] || {};
      const processorHeartbeatAt = toNumber(
        engineState.last_processor_heartbeat,
      );
      const processorHeartbeatFresh = isFreshHeartbeat(
        processorHeartbeatAt,
        now,
      );
      const configured =
        isTruthyFlag(conn.is_enabled) ||
        isTruthyFlag((conn as any).is_enabled_dashboard);
      const running =
        configured &&
        globalOperatorStatus === "running" &&
        !["paused", "stopped"].includes(globalOperatorStatus) &&
        processorHeartbeatFresh;
      const runtimeStatus = running
        ? "running"
        : configured && globalOperatorStatus === "running"
          ? "configured_no_worker_heartbeat"
          : configured
            ? "configured"
            : "disabled";

      return {
        id: conn.id,
        name: conn.name,
        exchange: conn.exchange,
        configured,
        runtimeStatus,
        running,
        processorHeartbeatFresh,
        lastProcessorHeartbeatAt: processorHeartbeatAt || null,
      };
    });
    const runningEngineConnections = engineConnections.filter((c) => c.running);
    const configuredWithoutHeartbeat = engineConnections.filter(
      (c) => c.runtimeStatus === "configured_no_worker_heartbeat",
    );

    const systemStatus = {
      timestamp: new Date().toISOString(),
      status: tradeEngineWorkerDiagnostic.missingFreshWorkerHeartbeat ? "degraded" : (activeConnections.length > 0 ? "healthy" : "degraded"),
      database: databaseInfo,
      connectionInventory: {
        total: allConnections.length,
        active: activeConnections.length,
        enabled: allConnections.filter((c) => isTruthyFlag(c.is_enabled))
          .length,
        disabled: allConnections.filter((c) => !isTruthyFlag(c.is_enabled))
          .length,
        byExchange,
        byApiType,
      },
      engineRuntime: {
        status:
          runningEngineConnections.length > 0
            ? "running"
            : globalOperatorStatus === "running" &&
                configuredConnections.length > 0
              ? "configured_no_worker_heartbeat"
              : globalOperatorStatus,
        running: runningEngineConnections.length > 0 || globalHeartbeatFresh,
        operatorStatus: globalOperatorStatus,
        heartbeatFresh:
          globalHeartbeatFresh ||
          runningEngineConnections.some((c) => c.processorHeartbeatFresh),
        globalHeartbeatFresh,
        lastGlobalHeartbeatAt: globalHeartbeatAt || null,
        configured: configuredConnections.length,
        runningConnections: runningEngineConnections.length,
        configuredWithoutWorkerHeartbeat: configuredWithoutHeartbeat.length,
        connections: engineConnections,
      },
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
        averageUptime:
          allHealth.length > 0
            ? (
                allHealth.reduce((sum, h) => sum + h.uptime, 0) /
                allHealth.length
              ).toFixed(2)
            : "N/A",
      },
      metrics: {
        totalRequests,
        successfulRequests,
        failedRequests,
        successRate:
          totalRequests > 0
            ? ((successfulRequests / totalRequests) * 100).toFixed(2)
            : "N/A",
        averageResponseTime,
      },
      batch: {
        queueLength: batchStatus.queueLength,
        activeTasks: batchStatus.activeTasks,
        maxConcurrent: batchStatus.maxConcurrent,
        completedTasks: batchStatus.completedTasks,
      },
      apiTypes: {
        supported: [
          "rest",
          "websocket",
          "unified",
          "perpetual_futures",
          "spot",
          "margin",
        ],
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
      tradeEngine: {
        status: tradeEngineWorkerDiagnostic.operatorIntent,
        worker: tradeEngineWorkerDiagnostic,
      },
      features: {
        rateLimiting: "enabled",
        batchProcessing: "enabled",
        connectionPooling: "enabled",
        healthMonitoring: "enabled",
        metricsTracking: "enabled",
        autoReconnection: "enabled",
      },
    };

    return NextResponse.json(systemStatus, { status: 200 });
  } catch (error) {
    console.error("[v0] System status error:", error);
    await SystemLogger.logError(error, "api", "GET /api/system/status");

    return NextResponse.json(
      {
        error: "Failed to retrieve system status",
        details: error instanceof Error ? error.message : "Unknown error",
        timestamp: new Date().toISOString(),
      },
      { status: 500 },
    );
  }
}
