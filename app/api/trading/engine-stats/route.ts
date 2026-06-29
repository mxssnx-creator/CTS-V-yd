import { NextResponse } from "next/server"
import { getRedisClient } from "@/lib/redis-db"

export const dynamic = "force-dynamic"
export async function GET(req: Request) {
  try {
    const { searchParams } = new URL(req.url)
    const connectionId = searchParams.get("connection_id")

    if (!connectionId) {
      return NextResponse.json({ error: "connection_id required" }, { status: 400 })
    }

    const redis = getRedisClient()

    // ── 1. Read live cycle counts from progression:{connId} hash ──────────────
    // This hash is updated EVERY indication cycle, so it is always current.
    const [progHashRaw, baseDetailRaw, realDetailRaw] = await Promise.all([
      redis.hgetall(`progression:${connectionId}`).catch(() => null),
      redis.hgetall(`strategy_detail:${connectionId}:base`).catch(() => null),
      redis.hgetall(`strategy_detail:${connectionId}:real`).catch(() => null),
    ])
    const progHash = progHashRaw || {}
    const baseDetail = baseDetailRaw || {}
    const realDetail = realDetailRaw || {}

    const indicationCycleCount = parseInt(progHash.indication_cycle_count || "0", 10)
    const indicationsCount     = parseInt(progHash.indications_count     || "0", 10)

    // Per-type indication counts stored as indications_{type}_count
    const indicationsByType: Record<string, number> = {}
    for (const [field, val] of Object.entries(progHash)) {
      if (field.startsWith("indications_") && field.endsWith("_count") && field !== "indications_count") {
        const typeName = field.replace("indications_", "").replace("_count", "")
        indicationsByType[typeName] = parseInt(String(val || "0"), 10)
      }
    }

    // ── 2. Read strategy counts ──────────────────────────────────────────────────
    // PRIMARY: progression hash. Live total is cumulative selected/created Live
    // sets after active dispatch-model selection; candidate totals are tracked
    // separately as strategies_live_candidates_total.
    let baseSetCount = parseInt(progHash.strategies_base_total || "0", 10)
    let mainSetCount = parseInt(progHash.strategies_main_total || "0", 10)
    let realSetCount = parseInt(progHash.strategies_real_total || "0", 10)
    let liveSetCount = parseInt(progHash.strategies_live_total || "0", 10)
    const liveCandidateCount = parseInt(progHash.strategies_live_candidates_total || "0", 10)

    // FALLBACK: settings:strategies:{connId}:*:sets hash keys (written by setSettings).
    // Only use if progression hash has no data yet (engine just started).
    if (baseSetCount === 0 && mainSetCount === 0) {
      try {
        const strategyKeys = await redis.keys(`settings:strategies:${connectionId}:*:sets`)
        for (const key of strategyKeys) {
          const hash = await redis.hgetall(key) || {}
          const count = parseInt(hash.count || "0", 10)
          if (key.includes(":base:"))      baseSetCount = Math.max(baseSetCount, count)
          else if (key.includes(":main:")) mainSetCount = Math.max(mainSetCount, count)
          else if (key.includes(":real:")) realSetCount = Math.max(realSetCount, count)
          else if (key.includes(":live:")) liveSetCount = Math.max(liveSetCount, count)
        }
      } catch (e) {
        console.warn("[v0] [EngineStats] Error reading strategy set keys:", e)
      }
    }

    // ── 3. Read strategy cycle count from progression hash (written every cycle) ─
    // The engine-manager writes strategy_cycle_count to progression:{connId}
    // every single cycle. settings:trade_engine_state is only persisted every 100 cycles.
    let strategyCycleCount = parseInt(progHash.strategy_cycle_count || "0", 10)
    // realtime_cycle_count is written to the progression hash every cycle by the
    // live driver (cron/generate-indications). Read it here directly — the old
    // code only read it from the settings:trade_engine_state fallback, which
    // never runs once strategyCycleCount > 0, so the realtime tiles stayed 0.
    let realtimeCycleCount = parseInt(progHash.realtime_cycle_count || "0", 10)
    let cycleSuccessRate = parseFloat(progHash.cycle_success_rate || "100")

    // Fallback: read from settings:trade_engine_state if progression hash is empty
    if (strategyCycleCount === 0) {
      try {
        const stateHash = await redis.hgetall(`settings:trade_engine_state:${connectionId}`) || {}
        strategyCycleCount = parseInt(stateHash.strategy_cycle_count || "0", 10)
        if (realtimeCycleCount === 0) {
          realtimeCycleCount = parseInt(stateHash.realtime_cycle_count || "0", 10)
        }
        if (!cycleSuccessRate) {
          cycleSuccessRate = parseFloat(stateHash.cycle_success_rate || "100")
        }
      } catch (e) {
        console.warn("[v0] [EngineStats] Error reading engine state fallback:", e)
      }
    }

    // Also read cycles_completed from ProgressionStateManager field for the overall count
    const cyclesCompleted = parseInt(progHash.cycles_completed || "0", 10)

    const n = (value: unknown): number => {
      const parsed = Number(value || 0)
      return Number.isFinite(parsed) ? parsed : 0
    }

    const stageDetail = (detail: Record<string, any>) => ({
      avgProfitFactor: n(detail.avg_profit_factor),
      avgPosPerSet: n(detail.avg_pos_per_set),
    })

    // ── 4. Read active pseudo positions count ────────────────────────────────────
    // PseudoPositionManager stores positions at:
    //   pseudo_positions:{connectionId}  → Redis set of IDs
    //   pseudo_position:{connectionId}:{id}  → Redis hash per position
    let positionsCount = 0
    try {
      const posIds = await redis.smembers(`pseudo_positions:${connectionId}`) || []
      for (const posId of posIds) {
        const hash = await redis.hgetall(`pseudo_position:${connectionId}:${posId}`) || {}
        if (hash.status === "open") positionsCount++
      }
      // Also check stage-specific position sets
      if (positionsCount === 0) {
        for (const stage of ["base", "main", "real", "live"]) {
          const stageIds = await redis.smembers(`${stage}_pseudo_positions:${connectionId}`).catch(() => [] as string[])
          for (const posId of stageIds) {
            const hash = (await redis.hgetall(`${stage}_pseudo_position:${connectionId}:${posId}`).catch(() => ({}))) as Record<string, any> || {}
            if ((hash as any).status === "open") positionsCount++
          }
        }
      }
    } catch (e) {
      // non-critical
    }

    // ── 4b. Resolve the real configured symbol count ─────────────────────────────
    // Previously this was hard-coded to 1, so the dashboard always showed "1"
    // even when quickstart enabled 10 symbols. Read the connection's
    // active_symbols (JSON string[]) and fall back to the progression hash's
    // symbol list if present.
    let symbolCount = 0
    try {
      const conn = (await redis.hgetall(`connection:${connectionId}`).catch(() => ({}))) as Record<string, any> || {}
      const rawSymbols = conn.active_symbols
      if (typeof rawSymbols === "string" && rawSymbols.length > 0) {
        try {
          const parsed = JSON.parse(rawSymbols)
          if (Array.isArray(parsed)) symbolCount = parsed.filter((s) => typeof s === "string" && s.length > 0).length
        } catch {
          // active_symbols may be a bare comma-separated string in older data
          symbolCount = rawSymbols.split(",").map((s) => s.trim()).filter(Boolean).length
        }
      }
      // Fallback: progression hash may track the processed-symbol count.
      if (symbolCount === 0) {
        const ps = parseInt(progHash.symbols_total || progHash.symbol_count || "0", 10)
        if (Number.isFinite(ps) && ps > 0) symbolCount = ps
      }
    } catch {
      // non-critical — leave at 0 if unavailable
    }

    // ── 5. Build response ────────────────────────────────────────────────────────
    // Canonical "total strategies" = REAL-stage count (the final filtered output).
    // Base → Main → Real → Live is a cascade filter (eval → filter → adjust → promote).
    // Stages share the SAME logical strategy — summing them would multi-count.
    // Live is a runtime subset of Real, also not part of the canonical total.
    const totalStrategySets = realSetCount

    return NextResponse.json({
      success: true,
      connectionId,
      // Flat fields (consumed by quickstart-section and dashboard)
      indicationCycleCount,
      strategyCycleCount,
      realtimeCycleCount,
      cyclesCompleted,
      cycleSuccessRate,
      totalIndicationsCount: indicationsCount,
      indicationsByType,
      baseStrategyCount:  baseSetCount,
      mainStrategyCount:  mainSetCount,
      realStrategyCount:  realSetCount,
      liveStrategyCount:  liveSetCount,
      liveStrategyCandidateCount: liveCandidateCount,
      totalStrategyCount: totalStrategySets,
      positionsCount,
      strategyDetail: {
        base: stageDetail(baseDetail),
        real: stageDetail(realDetail),
      },
      stageBase: stageDetail(baseDetail),
      stageReal: stageDetail(realDetail),
      baseAvgProfitFactor: n(baseDetail.avg_profit_factor),
      realActivePosAvg: n(progHash.real_active_pos_avg),
      openPositions: {
        real: {
          activeAvg: n(progHash.real_active_pos_avg),
          activeSamples: parseInt(progHash.real_active_pos_samples || "0", 10) || 0,
        },
      },
      progression: {
        strategy_base_avg_profit_factor: progHash.strategy_base_avg_profit_factor || baseDetail.avg_profit_factor || "0",
      },
      totalProfit: 0, // calculated from closed positions if needed
      // Legacy nested shapes for backward compat
      indications: {
        cycleCount: indicationCycleCount,
        totalRecords: indicationsCount,
        byType: indicationsByType,
      },
      strategies: {
        cycleCount: strategyCycleCount,
        base: baseSetCount,
        main: mainSetCount,
        real: realSetCount,
        live: liveSetCount,
        liveCandidates: liveCandidateCount,
        total: totalStrategySets,
        totalRecords: totalStrategySets,
      },
      realtime: {
        cycleCount: realtimeCycleCount,
      },
      metadata: {
        symbolCount,
      },
    })
  } catch (error) {
    console.error("[v0] Engine stats error:", error)
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Unknown error" },
      { status: 500 }
    )
  }
}
