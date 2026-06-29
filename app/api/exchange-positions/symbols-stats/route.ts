import { NextResponse } from "next/server"
import { initRedis, getAllConnections } from "@/lib/redis-db"
import { getLivePositions, getClosedLivePositions } from "@/lib/trade-engine/stages/live-stage"
import { isTruthyFlag } from "@/lib/connection-state-utils"

export const dynamic = "force-dynamic"

type SymbolStats = {
  symbol: string
  livePositions: number
  openPositions: number
  closedPositions: number
  realizedPnl: number
  unrealizedPnl: number
  effectivePnl: number
  wins: number
  losses: number
  winRate: number
  profitFactor250: number
  profitFactor50: number
  source: "exchange_live_positions"
}

function isRealExchangePosition(pos: any): boolean {
  const ex = pos?.exchangeData || {}
  return Boolean(
    pos?.orderId ||
      pos?.exchangeOrderId ||
      ex.exchangeOrderId ||
      ex.exchangePositionId ||
      ex.orderId ||
      ex.source === "exchange" ||
      ex.syncedFrom === "exchange",
  )
}

function pnlOf(pos: any): number {
  return Number(pos?.realizedPnL ?? pos?.realized_pnl ?? pos?.pnl ?? pos?.unrealizedPnL ?? pos?.exchangeData?.unrealizedPnl ?? pos?.exchangeData?.unrealizedPnL) || 0
}

function round2(n: number): number {
  return Math.round(n * 100) / 100
}

function finalizeStats(stats: SymbolStats): SymbolStats {
  const totalDecided = stats.wins + stats.losses
  stats.winRate = totalDecided > 0 ? round2((stats.wins / totalDecided) * 100) : 0
  stats.effectivePnl = round2(stats.realizedPnl + stats.unrealizedPnl)
  return stats
}

export async function GET() {
  try {
    console.log("[v0] Fetching aggregated exchange-positions statistics")

    await initRedis()
    const connections = await getAllConnections()
    const activeConnections = connections.filter((c: any) =>
      isTruthyFlag(c.is_enabled_dashboard) &&
      isTruthyFlag(c.is_enabled) &&
      isTruthyFlag(c.is_live_trade),
    )

    const bySymbol = new Map<string, SymbolStats>()
    for (const connection of activeConnections) {
      const [open, closed] = await Promise.all([
        getLivePositions(connection.id).catch(() => []),
        getClosedLivePositions(connection.id, 250).catch(() => []),
      ])
      for (const pos of [...open, ...closed].filter(isRealExchangePosition)) {
        const symbol = String((pos as any).symbol || "UNKNOWN")
        const current = bySymbol.get(symbol) || {
          symbol,
          livePositions: 0,
          openPositions: 0,
          closedPositions: 0,
          realizedPnl: 0,
          unrealizedPnl: 0,
          effectivePnl: 0,
          wins: 0,
          losses: 0,
          winRate: 0,
          profitFactor250: 0,
          profitFactor50: 0,
          source: "exchange_live_positions" as const,
        }
        current.livePositions += 1
        const pnl = pnlOf(pos)
        if ((pos as any).status === "closed") {
          current.closedPositions += 1
          current.realizedPnl = round2(current.realizedPnl + pnl)
          if (pnl > 0) current.wins += 1
          if (pnl < 0) current.losses += 1
        } else {
          current.openPositions += 1
          current.unrealizedPnl = round2(current.unrealizedPnl + pnl)
        }
        bySymbol.set(symbol, current)
      }
    }

    const symbols = Array.from(bySymbol.values())
      .map(finalizeStats)
      .sort((a, b) => Math.abs(b.effectivePnl) - Math.abs(a.effectivePnl))
      .slice(0, 22)

    return NextResponse.json({
      symbols,
      source: "exchange_live_positions",
      simulatedExcluded: true,
    })
  } catch (error) {
    console.error("[v0] Failed to fetch exchange-positions statistics:", error)
    return NextResponse.json({
      symbols: [],
      source: "exchange_live_positions",
      simulatedExcluded: true,
    })
  }
}
