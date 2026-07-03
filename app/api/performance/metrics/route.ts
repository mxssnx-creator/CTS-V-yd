import { performanceProfiler } from "@/lib/performance-profiler"
import { loadTestFramework } from "@/lib/load-test-framework"
import { NextRequest, NextResponse } from "next/server"

export const runtime = "nodejs"

export async function GET(request: NextRequest) {
  try {
    const searchParams = request.nextUrl.searchParams
    const action = searchParams.get("action") || "metrics"

    if (action === "metrics") {
      // Return current performance metrics
      const stats = performanceProfiler.getStats()
      return NextResponse.json({
        status: "ok",
        metrics: {
          cyclePerformance: {
            totalCycles: stats.totalCycles,
            avgDuration: `${stats.avgCycleDuration.toFixed(2)}ms`,
            p95Duration: `${stats.p95Duration.toFixed(2)}ms`,
            p99Duration: `${stats.p99Duration.toFixed(2)}ms`,
            maxDuration: `${stats.maxCycleDuration.toFixed(2)}ms`,
            minDuration: `${stats.minCycleDuration.toFixed(2)}ms`,
          },
          operationBreakdown: stats.operationBreakdown,
          slowCycles: stats.slowCycles.slice(0, 5).map((c) => ({
            phase: c.phase,
            connectionId: c.connectionId,
            symbol: c.symbol,
            duration: `${(c.duration || 0).toFixed(2)}ms`,
          })),
        },
      })
    } else if (action === "load-test") {
      // Run load test with configurable parameters
      const connections = parseInt(searchParams.get("connections") || "5") || 5
      const symbolsPerConnection = parseInt(searchParams.get("symbols") || "10") || 10
      const cyclesPerSymbol = parseInt(searchParams.get("cycles") || "3") || 3
      const concurrency = parseInt(searchParams.get("concurrency") || "30") || 30

      const result = await loadTestFramework.runLoadTest({
        connections,
        symbolsPerConnection,
        cyclesPerSymbol,
        concurrencyFactor: concurrency,
        failureThreshold: 5, // Allow max 5% failure
      })

      return NextResponse.json({
        status: result.passed ? "passed" : "failed",
        result: {
          totalOperations: result.totalOperations,
          successRate: `${result.successRate.toFixed(2)}%`,
          avgResponseTime: `${result.avgResponseTime.toFixed(2)}ms`,
          p95ResponseTime: `${result.p95ResponseTime.toFixed(2)}ms`,
          maxResponseTime: `${result.maxResponseTime.toFixed(2)}ms`,
          memoryDelta: `${result.memoryUsedMB.toFixed(2)}MB`,
          issues: result.issues,
        },
      })
    } else if (action === "reset") {
      performanceProfiler.reset()
      return NextResponse.json({ status: "ok", message: "Metrics reset" })
    } else {
      return NextResponse.json(
        { status: "error", message: "Invalid action" },
        { status: 400 }
      )
    }
  } catch (error) {
    console.error("[v0] Performance metrics error:", error)
    return NextResponse.json(
      { status: "error", message: String(error) },
      { status: 500 }
    )
  }
}
