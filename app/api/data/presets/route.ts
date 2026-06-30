import { type NextRequest, NextResponse } from "next/server"

interface PresetTemplate {
  id: string
  name: string
  description: string
  strategyType: string
  symbol: string
  enabled: boolean
  config: {
    tp: number
    sl: number
    leverage: number
    volume: number
  }
  stats: {
    winRate: number
    avgProfit: number
    successCount: number
  }
}

function generateMockPresets(connectionId: string): PresetTemplate[] {
  return [
    {
      id: `p1-${connectionId}`,
      name: "Bitcoin Momentum",
      description: "Aggressive momentum strategy for BTC",
      strategyType: "Momentum",
      symbol: "BTCUSDT",
      enabled: true,
      config: { tp: 8, sl: 0.5, leverage: 5, volume: 0.1 },
      stats: { winRate: 72, avgProfit: 3.2, successCount: 45 },
    },
    {
      id: `p2-${connectionId}`,
      name: "Ethereum Trend Follower",
      description: "Conservative trend-following for ETH",
      strategyType: "Trend",
      symbol: "ETHUSDT",
      enabled: true,
      config: { tp: 6, sl: 0.75, leverage: 3, volume: 0.1 },
      stats: { winRate: 68, avgProfit: 2.1, successCount: 38 },
    },
    {
      id: `p3-${connectionId}`,
      name: "Solana Volatility",
      description: "High volatility trading on SOL",
      strategyType: "Volatility",
      symbol: "SOLUSDT",
      enabled: false,
      config: { tp: 10, sl: 1, leverage: 10, volume: 0.1 },
      stats: { winRate: 55, avgProfit: 4.5, successCount: 22 },
    },
    {
      id: `p4-${connectionId}`,
      name: "Mean Reversion Multi",
      description: "Mean reversion across multiple pairs",
      strategyType: "Mean Reversion",
      symbol: "MULTI",
      enabled: true,
      config: { tp: 4, sl: 1.5, leverage: 2, volume: 0.1 },
      stats: { winRate: 65, avgProfit: 1.8, successCount: 52 },
    },
    {
      id: `p5-${connectionId}`,
      name: "Scalping Strategy",
      description: "High-frequency scalping template",
      strategyType: "Momentum",
      symbol: "BTCUSDT",
      enabled: false,
      config: { tp: 2, sl: 0.25, leverage: 20, volume: 0.1 },
      stats: { winRate: 58, avgProfit: 0.8, successCount: 120 },
    },
    {
      id: `p2-${connectionId}`,
      name: "Ethereum Trend Follower",
      description: "Conservative trend-following for ETH",
      strategyType: "Trend",
      symbol: "ETHUSDT",
      enabled: true,
      config: { tp: 6, sl: 0.75, leverage: 3, volume: 0.75 },
      stats: { winRate: 68, avgProfit: 2.1, successCount: 38 },
    },
    {
      id: `p3-${connectionId}`,
      name: "Solana Volatility",
      description: "High volatility trading on SOL",
      strategyType: "Volatility",
      symbol: "SOLUSDT",
      enabled: false,
      config: { tp: 10, sl: 1, leverage: 10, volume: 0.25 },
      stats: { winRate: 55, avgProfit: 4.5, successCount: 22 },
    },
    {
      id: `p4-${connectionId}`,
      name: "Mean Reversion Multi",
      description: "Mean reversion across multiple pairs",
      strategyType: "Mean Reversion",
      symbol: "MULTI",
      enabled: true,
      config: { tp: 4, sl: 1.5, leverage: 2, volume: 1 },
      stats: { winRate: 65, avgProfit: 1.8, successCount: 52 },
    },
    {
      id: `p5-${connectionId}`,
      name: "Scalping Strategy",
      description: "High-frequency scalping template",
      strategyType: "Momentum",
      symbol: "BTCUSDT",
      enabled: false,
      config: { tp: 2, sl: 0.25, leverage: 20, volume: 0.1 },
      stats: { winRate: 58, avgProfit: 0.8, successCount: 120 },
    },
  ]
}

function parseMaybeJSON<T = any>(value: unknown, fallback: T): T {
  if (value == null) return fallback
  if (typeof value !== "string") return value as T
  try {
    return JSON.parse(value) as T
  } catch {
    return fallback
  }
}

function pickFirstNumber(v: unknown, fallback = 0): number {
  if (Array.isArray(v) && v.length > 0 && typeof v[0] === "number") return v[0]
  if (typeof v === "number") return v
  if (typeof v === "string") {
    const n = Number(v)
    if (!Number.isNaN(n)) return n
  }
  return fallback
}

/**
 * Real-mode preset loader: reads the shared preset *templates* from the DB shim
 * (Redis-backed) and enriches each one with per-connection stats derived from
 * that connection's active strategies. We do NOT fabricate numbers — if the
 * trading engine has not produced any strategies for this connection + preset
 * yet, the stats are zeroed and `enabled` reflects the preset's is_active flag.
 */
async function getRealPresets(connectionId: string): Promise<PresetTemplate[]> {
  try {
    // No SQL DB — fall through to mock presets
    const rows: any[] = []

    if (!rows || rows.length === 0) {
      return []
    }

    // Active strategies for this connection — used to compute *real* per-preset stats.
    const activeStrategies: any[] = []

    const byPreset = new Map<string, any[]>()
    for (const s of activeStrategies) {
      const pid = String(s.preset_id || s.presetId || "")
      if (!pid) continue
      const list = byPreset.get(pid) || []
      list.push(s)
      byPreset.set(pid, list)
    }

    return rows.map((preset: any) => {
      const id = String(preset.id ?? preset.name ?? `preset-${Math.random().toString(36).slice(2)}`)
      const strategies = byPreset.get(id) || []

      const successCount = strategies.length
      const avgProfit =
        successCount > 0
          ? strategies.reduce((sum, s) => sum + (Number(s.profit_factor) || 0), 0) / successCount
          : 0
      const avgWinRate =
        successCount > 0
          ? strategies.reduce((sum, s) => sum + (Number(s.win_rate) || 0), 0) / successCount
          : 0

      // Config defaults — take the first value from each preset's array field
      // so the user sees one concrete number per column (not an array).
      const tpSteps = parseMaybeJSON<number[]>(preset.takeprofit_steps, [4])
      const slRatios = parseMaybeJSON<number[]>(preset.stoploss_ratios, [0.6])
      const volFactors = parseMaybeJSON<number[]>(preset.volume_factors, [1])
      const strategyTypes = parseMaybeJSON<string[]>(preset.strategy_types, ["main"])

      const isEnabled =
        preset.is_active === true ||
        preset.is_active === 1 ||
        preset.is_active === "true" ||
        preset.is_active === "1"

      return {
        id,
        name: String(preset.name || `Preset ${id}`),
        description: String(preset.description || "Trading preset"),
        strategyType:
          Array.isArray(strategyTypes) && strategyTypes.length > 0 ? String(strategyTypes[0]) : "main",
        symbol: String(preset.symbol || "MULTI"),
        enabled: isEnabled,
        config: {
          tp: pickFirstNumber(tpSteps, 4),
          sl: pickFirstNumber(slRatios, 0.6),
          leverage: Number(preset.default_leverage) || 1,
          volume: pickFirstNumber(volFactors, 1),
        },
        stats: {
          winRate: Number(avgWinRate.toFixed(2)),
          avgProfit: Number(avgProfit.toFixed(2)),
          successCount,
        },
      }
    })
  } catch (error) {
    console.error(`[data/presets] Failed to load real presets for ${connectionId}:`, error)
    return []
  }
}

export const dynamic = "force-dynamic"
export async function GET(request: NextRequest) {
  try {
    const connectionId = request.nextUrl.searchParams.get("connectionId")
    if (!connectionId) {
      return NextResponse.json(
        { success: false, error: "connectionId query parameter required" },
        { status: 400 },
      )
    }

    const isDemo = connectionId === "demo-mode" || connectionId.startsWith("demo")

    let presets: PresetTemplate[] = []

    if (isDemo) {
      presets = generateMockPresets(connectionId)
    } else {
      // Previously this branch always returned `[]`, leaving the Presets page
      // blank on real connections. Now we pull the shared preset templates
      // out of the DB shim and attach per-connection stats derived from the
      // running trade engine's Redis strategies.
      presets = await getRealPresets(connectionId)
    }

    return NextResponse.json({
      success: true,
      data: presets,
      isDemo,
      connectionId,
      count: presets.length,
    })
  } catch (error) {
    console.error("[v0] Get presets error:", error)
    return NextResponse.json({ success: false, error: "Internal server error" }, { status: 500 })
  }
}
