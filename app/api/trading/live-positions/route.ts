import { NextResponse } from "next/server"
import {
  getLivePositions,
  getClosedLivePositions,
  calculateLivePositionStats,
} from "@/lib/trade-engine/stages/live-stage"
import { initRedis, getRedisClient, getConnection } from "@/lib/redis-db"
import { isTruthyFlag } from "@/lib/connection-state-utils"

export const dynamic = "force-dynamic"

type LiveSource = "real" | "simulated" | "unknown"

function getLiveSource(pos: any): LiveSource {
  if (pos?.status === "simulated") return "simulated"
  if (String(pos?.statusReason || "").includes("live_trade disabled")) return "simulated"
  const ex = pos?.exchangeData || {}
  if (
    pos?.orderId ||
    pos?.exchangeOrderId ||
    ex.exchangeOrderId ||
    ex.exchangePositionId ||
    ex.orderId ||
    ex.source === "exchange" ||
    ex.syncedFrom === "exchange"
  ) {
    return "real"
  }
  return "unknown"
}

function normalizePosition(pos: any) {
  const source = getLiveSource(pos)
  return {
    ...pos,
    dataSource: source,
    isRealExchangeData: source === "real",
    isSimulated: source === "simulated",
  }
}

function enrichPnl(pos: any) {
  const exchangePnl = Number(pos.exchangeData?.unrealizedPnl ?? pos.exchangeData?.unrealizedPnL)
  if (Number.isFinite(exchangePnl) && pos.status !== "closed") {
    pos.unrealizedPnL = Math.round(exchangePnl * 100) / 100
  }

  if (!pos.unrealizedPnL && pos.status !== "closed" && pos.exchangeData?.markPrice && pos.averageExecutionPrice && pos.executedQuantity) {
    const markPrice = Number(pos.exchangeData.markPrice)
    const entryPrice = Number(pos.averageExecutionPrice || pos.entryPrice || 0)
    const qty = Number(pos.executedQuantity || 0)
    if (entryPrice > 0 && markPrice > 0 && qty > 0) {
      const pnl = qty * (pos.direction === "long" ? markPrice - entryPrice : entryPrice - markPrice)
      pos.unrealizedPnL = Math.round(pnl * 100) / 100
    }
  }

  const realized = Number(pos.realizedPnL ?? pos.realized_pnl ?? pos.pnl)
  if (pos.status === "closed" && Number.isFinite(realized)) {
    pos.realizedPnL = Math.round(realized * 100) / 100
  }

  const pnl = Number(pos.unrealizedPnL ?? pos.realizedPnL)
  const lev = Math.max(1, Number(pos.leverage || 1))
  const entryPrice = Number(pos.averageExecutionPrice || pos.entryPrice || 0)
  const qty = Number(pos.executedQuantity || pos.quantity || 0)
  const notional = entryPrice * qty
  const margin = notional > 0 ? notional / lev : 0
  if (Number.isFinite(pnl) && margin > 0) {
    const roi = Math.round((pnl / margin) * 100 * 100) / 100
    if (pos.status === "closed") pos.realizedRoi = roi
    else pos.unrealizedRoi = roi
  }

  return pos
}

function computeStats(positions: any[]) {
  const closed = positions.filter((p) => p.status === "closed")
  const open = positions.filter((p) => ["open", "filled", "partially_filled", "placed", "pending_fill", "placed_unconfirmed"].includes(p.status))
  const totalRealizedPnL = closed.reduce((sum, p) => sum + (Number(p.realizedPnL ?? p.realized_pnl ?? p.pnl) || 0), 0)
  const totalUnrealizedPnL = open.reduce((sum, p) => sum + (Number(p.unrealizedPnL ?? p.exchangeData?.unrealizedPnl ?? p.exchangeData?.unrealizedPnL) || 0), 0)
  const wins = closed.filter((p) => (Number(p.realizedPnL ?? p.realized_pnl ?? p.pnl) || 0) > 0).length
  const losses = closed.filter((p) => (Number(p.realizedPnL ?? p.realized_pnl ?? p.pnl) || 0) < 0).length
  const winRate = wins + losses > 0 ? Math.round((wins / (wins + losses)) * 10000) / 100 : 0
  return {
    total: positions.length,
    open: open.length,
    closed: closed.length,
    totalRealizedPnL: Math.round(totalRealizedPnL * 100) / 100,
    totalUnrealizedPnL: Math.round(totalUnrealizedPnL * 100) / 100,
    effectivePnL: Math.round((totalRealizedPnL + totalUnrealizedPnL) * 100) / 100,
    wins,
    losses,
    winRate,
  }
}

/**
 * Returns all live positions for a connection, split into open and closed
 * buckets (via dedicated Redis index lists), plus aggregate stats.
 *
 * Query params:
 *   connection_id / connectionId - connection to query (default "bingx-x01")
 *   closedLimit                 - max number of closed positions to include (default 200)
 *   status                      - optional filter (e.g. "open", "closed", "error")
 *   source                      - all|real|simulated|unknown (default all)
 */
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url)
  const connectionId = searchParams.get("connection_id") || searchParams.get("connectionId") || "bingx-x01"
  const closedLimit = Math.min(1000, Math.max(1, parseInt(searchParams.get("closedLimit") || "200", 10)))
  const statusFilter = searchParams.get("status") || undefined
  const sourceFilter = (searchParams.get("source") || "all").toLowerCase()

  try {
    await initRedis()

    const [open, closed, connection] = await Promise.all([
      getLivePositions(connectionId),
      getClosedLivePositions(connectionId, closedLimit),
      getConnection(connectionId).catch(() => null),
    ])

    // Fallback: also scan for any positions stored under alternate key patterns
    const client = getRedisClient()
    const altKeys = await client
      .keys(`live:position:live:${connectionId}:*`)
      .catch(() => [] as string[])
    const altPositions: any[] = []
    const seenIds = new Set<string>([...open.map((p) => p.id!).filter(Boolean), ...closed.map((p) => p.id!).filter(Boolean)])
    for (const key of altKeys) {
      try {
        const raw = await client.get(key)
        if (raw) {
          const p = JSON.parse(raw)
          if (!seenIds.has(p.id)) {
            altPositions.push(p)
            seenIds.add(p.id)
          }
        }
      } catch { /* skip malformed */ }
    }

    const all = [...open, ...closed, ...altPositions]
      .map((pos) => enrichPnl(normalizePosition(pos)))
      .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))

    const realPositions = all.filter((p) => p.dataSource === "real")
    const simulatedPositions = all.filter((p) => p.dataSource === "simulated")
    const unknownPositions = all.filter((p) => p.dataSource === "unknown")

    const sourceFiltered =
      sourceFilter === "real" ? realPositions :
        sourceFilter === "simulated" ? simulatedPositions :
          sourceFilter === "unknown" ? unknownPositions :
            all

    const filtered = statusFilter
      ? sourceFiltered.filter((p) => p.status === statusFilter)
      : sourceFiltered

    const legacyStats = await calculateLivePositionStats(connectionId).catch(() => ({
      totalFilled: 0,
      totalOpen: 0,
      totalClosed: 0,
      totalPnL: 0,
      averageROI: 0,
      winRate: 0,
    }))

    const liveTradeEnabled = Boolean(connection && isTruthyFlag((connection as any).is_live_trade))
    const liveTradeRequested = Boolean(connection && isTruthyFlag((connection as any).live_trade_requested))
    const liveTradeBlockedReason = String((connection as any)?.live_trade_blocked_reason || "")

    return NextResponse.json({
      connectionId,
      sourceFilter,
      positions: filtered,
      realPositions,
      simulatedPositions,
      counts: {
        total: all.length,
        real: realPositions.length,
        simulated: simulatedPositions.length,
        unknown: unknownPositions.length,
        open: all.filter((p) => p.status === "open").length,
        pending: all.filter((p) => p.status === "pending").length,
        placed: all.filter((p) => p.status === "placed" || p.status === "pending_fill" || p.status === "placed_unconfirmed").length,
        pending_fill: all.filter((p) => p.status === "pending_fill").length,
        filled: all.filter((p) => p.status === "filled").length,
        closed: all.filter((p) => p.status === "closed").length,
        rejected: all.filter((p) => p.status === "rejected").length,
        error: all.filter((p) => p.status === "error").length,
      },
      stats: {
        ...legacyStats,
        all: computeStats(all),
        real: computeStats(realPositions),
        simulated: computeStats(simulatedPositions),
      },
      dataIntegrity: {
        liveTradeEnabled,
        liveTradeRequested,
        liveTradeBlockedReason,
        realExchangeDataComplete: realPositions.length > 0 || !liveTradeEnabled,
        message: liveTradeEnabled
          ? "Real exchange positions are separated from simulated/paper positions and use exchange-synced order/position identifiers when available."
          : "Live exchange order placement is not enabled; returned exchange-real history may be empty and simulated positions are separated from real data.",
      },
    })
  } catch (err) {
    console.warn("[v0] [LivePositions API] Error:", err instanceof Error ? err.message : String(err))
    return NextResponse.json({
      connectionId,
      positions: [],
      realPositions: [],
      simulatedPositions: [],
      counts: { total: 0, real: 0, simulated: 0 },
      stats: null,
    })
  }
}
