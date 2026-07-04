import { NextResponse, type NextRequest } from "next/server"
import { initRedis, getAllConnections, getRedisClient } from "@/lib/redis-db"
import { RedisMonitoring, RedisPositions, RedisTrades } from "@/lib/redis-operations"

export const dynamic = "force-dynamic"
export const fetchCache = "force-no-store"

export async function GET(request: NextRequest) {
  try {
    const searchParams = request.nextUrl.searchParams
    const exchangeFilter = searchParams.get("exchange")

    await initRedis()

    // Use all connections for position/trade queries; filter for active-inserted engines
    const allConns = await getAllConnections()
    let connections = allConns

    if (exchangeFilter) {
      connections = connections.filter((c: any) => c.exchange === exchangeFilter)
    }

    // Active processing connections must be assigned and dashboard-enabled.
    const isOn = (value: unknown) => value === true || value === 1 || value === "1" || value === "true"
    const activeConnections = connections.filter((c: any) => {
      const assigned = isOn(c.is_assigned) || isOn(c.is_active_inserted) || isOn(c.is_dashboard_inserted)
      return assigned && isOn(c.is_enabled_dashboard)
    })

    let totalPositions = 0
    let openPositions = 0
    let totalTrades = 0
    let dailyPnL = 0
    let unrealizedPnL = 0

    for (const conn of connections) {
      const positions = await RedisPositions.getPositionsByConnection(conn.id)
      const trades = await RedisTrades.getTradesByConnection(conn.id)

      totalPositions += positions.length
      totalTrades += trades.length

      const open = positions.filter(
        (p: any) => p.status !== "closed" && p.status !== "CLOSED",
      )
      openPositions += open.length

      positions.forEach((pos: any) => {
        if (pos.status === "closed" || pos.status === "CLOSED") {
          dailyPnL += parseFloat(pos.realized_pnl || "0")
        } else {
          unrealizedPnL += parseFloat(pos.unrealized_pnl || "0")
        }
      })
    }

    const stats = await RedisMonitoring.getStatistics()

    // Get real engine progression data from Redis
    let totalCycles = 0
    let totalIndications = 0
    let totalStrategies = 0
    
    try {
      const client = getRedisClient()
      // progression:* keys are Redis HASHES (written with hset/hincrby) — must use hgetall
      const progressionKeys = await client.keys("progression:*")
      
      for (const key of progressionKeys) {
        try {
          const hash = await client.hgetall(key)
          if (hash) {
            totalCycles      += parseInt(hash.indication_cycle_count || "0", 10)
            totalIndications += parseInt(hash.indications_count      || "0", 10)
            totalStrategies  += parseInt(hash.strategies_count       || "0", 10)
          }
        } catch (e) {
          // Silently skip errors per key
        }
      }
    } catch (e) {
      // non-critical
    }

    return NextResponse.json({
      activeConnections: activeConnections.length,
      totalConnections: connections.length,
      totalPositions,
      openPositions,
      totalTrades,
      dailyPnL: Number(dailyPnL.toFixed(2)),
      unrealizedPnL: Number(unrealizedPnL.toFixed(2)),
      totalBalance: Number((dailyPnL + unrealizedPnL).toFixed(2)),
      statistics: {
        ...stats,
        totalCycles,
        totalIndications,
        totalStrategies,
        avgCycleDuration: (stats as any)?.avgCycleDuration || 0,
        winRate250: (stats as any)?.winRate250 || 0.5,
        profitFactor250: (stats as any)?.profitFactor250 || 1.0,
        winRate50: (stats as any)?.winRate50 || 0.5,
        profitFactor50: (stats as any)?.profitFactor50 || 1.0,
        uptime: (stats as any)?.uptime || (totalCycles > 0 ? `${totalCycles} cycles` : "Starting..."),
      },
      timestamp: new Date().toISOString(),
    })
  } catch (error) {
    console.error("[v0] Error fetching monitoring stats:", error)
    return NextResponse.json(
      {
        activeConnections: 0,
        totalConnections: 0,
        totalPositions: 0,
        openPositions: 0,
        totalTrades: 0,
        dailyPnL: 0,
        unrealizedPnL: 0,
        totalBalance: 0,
        error: "Failed to fetch stats",
        details: error instanceof Error ? error.message : "Unknown error",
      },
      { status: 500 },
    )
  }
}
