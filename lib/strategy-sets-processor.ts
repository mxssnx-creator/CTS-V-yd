/**
 * Independent Strategy Sets Processor
 * Maintains separate 500-entry pools for each strategy calculation type
 * Each type evaluates independently with own set configurations
 */

import { getRedisClient, initRedis, getSettings, setSettings } from "@/lib/redis-db"
import { logProgressionEvent } from "@/lib/engine-progression-logs"
import { emitStrategyUpdate } from "@/lib/broadcast-helpers"
import {
  compact,
  loadCompactionConfig,
  type CompactionConfig,
  type SetCompactionType,
} from "@/lib/sets-compaction"

// Pre-cached client reference
let cachedClient: any = null
async function getCachedClient() {
  if (!cachedClient) {
    await initRedis()
    cachedClient = getRedisClient()
  }
  return cachedClient
}

// Default limits per strategy type (independently configurable)
export const MAX_INPUT_MULTIPLIER = 2

const DEFAULT_LIMITS = {
  base: 900,
  main: 300,
  real: 120,
  live: 500,
}

export interface StrategySetLimits {
  base: number
  main: number
  real: number
  live: number
}

export interface StrategySet {
  type: "base" | "main" | "real" | "live"
  connectionId: string
  symbol: string
  entries: Array<{
    id: string
    timestamp: Date
    profitFactor: number
    confidence: number
    config: any
    metadata: any
  }>
  maxEntries: number // Configurable per type, default 500
  stats: {
    totalCalculated: number
    totalQualified: number
    avgProfitFactor: number
    lastCalculated: Date | null
  }
}

export class StrategySetsProcessor {
  private connectionId: string
  private limits: StrategySetLimits = { ...DEFAULT_LIMITS }
  private explicitLimitOverrides: Partial<Record<keyof StrategySetLimits, boolean>> = {}
  private settingsReady: Promise<void>
  /**
   * Per-type compaction config cache. Refreshed lazily by the underlying
   * `loadCompactionConfig` helper (5s TTL). Strategy pools use the
   * "best" compaction mode — when the buffer overflows we keep the
   * highest-PF entries, not the most recent ones, because what
   * downstream Real/Live look up is "the best signals available", not
   * "the most recent ones".
   */
  private compactionCfgs: Partial<Record<SetCompactionType, CompactionConfig>> = {}

  /**
   * Resolve the compaction config for a strategy pool, with the legacy
   * per-type limit (`getLimit()`) as the floor when no operator-level
   * override exists. Mirrors the indication-sets processor for
   * uniformity.
   */
  private async resolveCompaction(
    type: keyof StrategySetLimits,
  ): Promise<CompactionConfig> {
    const ckey = `strategy.${type}` as SetCompactionType
    const cached = this.compactionCfgs[ckey]
    if (cached) return cached
    const cfg = await loadCompactionConfig(ckey)
    const legacyLimit = this.getLimit(type)
    // The user may have customised the legacy `strategy_sets_config`
    // floor (e.g. base=900). Prefer that when no operator-level
    // Set-Compaction override is set — detected by the resolved floor
    // being the hard-coded 250 default.
    const finalCfg: CompactionConfig =
      this.explicitLimitOverrides[type] || (cfg.floor === 250 && legacyLimit > 250)
        ? { floor: legacyLimit, thresholdPct: cfg.thresholdPct }
        : cfg
    this.compactionCfgs[ckey] = finalCfg
    return finalCfg
  }

  constructor(connectionId: string) {
    this.connectionId = connectionId
    this.settingsReady = this.loadSettings()
  }

  private async loadSettings(): Promise<void> {
    try {
      const settings = await getSettings("strategy_sets_config")
      if (settings) {
        // Load independent limits per type
        if (settings.base) { this.limits.base = Number(settings.base); this.explicitLimitOverrides.base = true }
        if (settings.main) { this.limits.main = Number(settings.main); this.explicitLimitOverrides.main = true }
        if (settings.real) { this.limits.real = Number(settings.real); this.explicitLimitOverrides.real = true }
        if (settings.live) { this.limits.live = Number(settings.live); this.explicitLimitOverrides.live = true }
        // Fallback: legacy maxEntriesPerSet applies weighted by type.
        if (settings.maxEntriesPerSet && !settings.base) {
          const limit = Number(settings.maxEntriesPerSet)
          this.limits = {
            base: Math.max(300, Math.round(limit * 1.8)),
            main: Math.max(120, Math.round(limit * 0.8)),
            real: Math.max(60, Math.round(limit * 0.35)),
            live: Math.max(120, limit),
          }
        }
      }
    } catch (error) {
      console.error("[v0] [StrategySets] Failed to load settings:", error)
    }
  }

  /** Get the limit for a specific strategy type */
  getLimit(type: keyof StrategySetLimits): number {
    return this.limits[type] || DEFAULT_LIMITS[type] || 500
  }


  private selectTopIndications(indications: any[], limit: number): any[] {
    if (indications.length <= limit * 4) {
      return [...indications]
        .sort((a, b) => (b.profitFactor ?? 0) - (a.profitFactor ?? 0))
        .slice(0, limit)
    }

    // Memory-safe top-K selection for full progression runs. Use a bounded
    // min-heap so we keep only K references and avoid sorting/copying the full
    // indication array. This is O(N log K) instead of the previous O(N*K)
    // replacement scan and avoids large transient arrays during complete runs.
    const heap: any[] = []
    const pf = (item: any) => Number(item?.profitFactor ?? 0)
    const swap = (i: number, j: number) => {
      const tmp = heap[i]
      heap[i] = heap[j]
      heap[j] = tmp
    }
    const bubbleUp = (idx: number) => {
      while (idx > 0) {
        const parent = Math.floor((idx - 1) / 2)
        if (pf(heap[parent]) <= pf(heap[idx])) break
        swap(parent, idx)
        idx = parent
      }
    }
    const sinkDown = (idx: number) => {
      while (true) {
        const left = idx * 2 + 1
        const right = left + 1
        let smallest = idx
        if (left < heap.length && pf(heap[left]) < pf(heap[smallest])) smallest = left
        if (right < heap.length && pf(heap[right]) < pf(heap[smallest])) smallest = right
        if (smallest === idx) break
        swap(idx, smallest)
        idx = smallest
      }
    }

    for (const indication of indications) {
      if (heap.length < limit) {
        heap.push(indication)
        bubbleUp(heap.length - 1)
        continue
      }
      if (pf(indication) <= pf(heap[0])) continue
      heap[0] = indication
      sinkDown(0)
    }

    return heap.sort((a, b) => (b.profitFactor ?? 0) - (a.profitFactor ?? 0))
  }

  /**
   * Process all strategy types independently for a symbol
   */
  async processAllStrategySets(symbol: string, indications: any[]): Promise<void> {
    try {
      const startTime = Date.now()
      await this.settingsReady

      const [baseCfg, mainCfg, realCfg, liveCfg] = await Promise.all([
        this.resolveCompaction("base"),
        this.resolveCompaction("main"),
        this.resolveCompaction("real"),
        this.resolveCompaction("live"),
      ])
      const maxLimit = Math.max(baseCfg.floor, mainCfg.floor, realCfg.floor, liveCfg.floor)
      const candidateLimit = Math.max(100, maxLimit * MAX_INPUT_MULTIPLIER)

      // Sort indications by profitFactor descending so that the best-performing
      // signals are processed first across all strategy type pools.
      const rawTotal = indications.length
      const selectedIndications = this.selectTopIndications(indications, candidateLimit)
      const selectedTotal = selectedIndications.length

      // Process all 4 strategy types in parallel with independent logic
      const [baseResults, mainResults, realResults, liveResults] = await Promise.all([
        this.processBaseStrategySet(symbol, selectedIndications, rawTotal, selectedTotal),
        this.processMainStrategySet(symbol, selectedIndications, rawTotal, selectedTotal),
        this.processRealStrategySet(symbol, selectedIndications, rawTotal, selectedTotal),
        this.processLiveStrategySet(symbol, selectedIndications, rawTotal, selectedTotal),
      ])

      const duration = Date.now() - startTime
      const totalQualified =
        (baseResults?.qualified || 0) +
        (mainResults?.qualified || 0) +
        (realResults?.qualified || 0) +
        (liveResults?.qualified || 0)

      if (totalQualified > 0) {
        console.log(
          `[v0] [StrategySets] ${symbol}: All types evaluated in ${duration}ms | Raw=${rawTotal} Selected=${selectedTotal} | Total qualified=${totalQualified} | Base qualified=${baseResults?.qualified} Main qualified=${mainResults?.qualified} Real qualified=${realResults?.qualified} Live qualified=${liveResults?.qualified}`
        )

        await logProgressionEvent(this.connectionId, "strategies_sets", "info", `All strategy types evaluated for ${symbol}`, {
          totalQualified,
          base: baseResults,
          main: mainResults,
          real: realResults,
          live: liveResults,
          duration,
        })
      }
    } catch (error) {
      console.error(`[v0] [StrategySets] Failed to process sets for ${symbol}:`, error)
    }
  }

  /**
   * Base Strategy Set - Conservative, low-risk signals only
   */
  private toStageResult(
    type: "base" | "main" | "real" | "live",
    rawTotal: number,
    selectedTotal: number,
    qualified: number,
  ): any {
    return { type, rawTotal, selectedTotal, qualified }
  }

  private async processBaseStrategySet(
    symbol: string,
    indications: any[],
    rawTotal: number,
    selectedTotal: number,
  ): Promise<any> {
    const setKey = `strategy_set:${this.connectionId}:${symbol}:base`
    let qualified = 0

    const batch: Array<{ strategy: any; indicationType: string }> = []
    for (const indication of indications) {
      // Base: broad intake (must be much higher volume than main/real)
      if (indication.confidence > 0.45 && indication.profitFactor > 0.9) {
        const strategy = {
          profitFactor: indication.profitFactor * 0.95,
          confidence: indication.confidence,
          metadata: { ...indication.metadata, strategyType: "base", riskLevel: "low" },
        }
        if (strategy.profitFactor >= 1.0) {
          qualified++
          batch.push({ strategy, indicationType: indication.type })
        }
      }
    }
    await this.saveBatchToSet(setKey, batch, "base")
    return this.toStageResult("base", rawTotal, selectedTotal, qualified)
  }

  /**
   * Main Strategy Set - Balanced, medium-risk signals
   */
  private async processMainStrategySet(
    symbol: string,
    indications: any[],
    rawTotal: number,
    selectedTotal: number,
  ): Promise<any> {
    const setKey = `strategy_set:${this.connectionId}:${symbol}:main`
    let qualified = 0

    const batch: Array<{ strategy: any; indicationType: string }> = []
    for (const indication of indications) {
      if (indication.confidence > 0.62 && indication.profitFactor > 1.2) {
        const strategy = {
          profitFactor: indication.profitFactor,
          confidence: indication.confidence,
          metadata: { ...indication.metadata, strategyType: "main", riskLevel: "medium" },
        }
        if (strategy.profitFactor >= 1.0) {
          qualified++
          batch.push({ strategy, indicationType: indication.type })
        }
      }
    }
    await this.saveBatchToSet(setKey, batch, "main")
    return this.toStageResult("main", rawTotal, selectedTotal, qualified)
  }

  /**
   * Real Strategy Set - Aggressive, higher-risk signals
   */
  private async processRealStrategySet(
    symbol: string,
    indications: any[],
    rawTotal: number,
    selectedTotal: number,
  ): Promise<any> {
    const setKey = `strategy_set:${this.connectionId}:${symbol}:real`
    let qualified = 0

    const batch: Array<{ strategy: any; indicationType: string }> = []
    for (const indication of indications) {
      if (indication.confidence > 0.78 && indication.profitFactor > 1.45) {
        const strategy = {
          profitFactor: indication.profitFactor * 1.1,
          confidence: indication.confidence,
          metadata: { ...indication.metadata, strategyType: "real", riskLevel: "high" },
        }
        if (strategy.profitFactor >= 1.0) {
          qualified++
          batch.push({ strategy, indicationType: indication.type })
        }
      }
    }
    await this.saveBatchToSet(setKey, batch, "real")
    return this.toStageResult("real", rawTotal, selectedTotal, qualified)
  }

  /**
   * Live Strategy Set - All qualifying signals, real-time only
   */
  private async processLiveStrategySet(
    symbol: string,
    indications: any[],
    rawTotal: number,
    selectedTotal: number,
  ): Promise<any> {
    const setKey = `strategy_set:${this.connectionId}:${symbol}:live`
    let qualified = 0

    const batch: Array<{ strategy: any; indicationType: string }> = []
    for (const indication of indications) {
      if (indication.profitFactor >= 1.0) {
        const strategy = {
          profitFactor: indication.profitFactor,
          confidence: indication.confidence,
          metadata: { ...indication.metadata, strategyType: "live", riskLevel: "variable" },
        }
        qualified++
        batch.push({ strategy, indicationType: indication.type })
      }
    }
    await this.saveBatchToSet(setKey, batch, "live")
    return this.toStageResult("live", rawTotal, selectedTotal, qualified)
  }

  /**
   * Batch-save multiple qualifying strategies to the same set pool in
   * ONE read-merge-compact-write transaction.
   *
   * The original `saveStrategyToSet` was called once per qualifying
   * indication in a sequential loop, paying the read-modify-write cost
   * per entry. With ~hundreds of qualifying indications per symbol
   * that was the dominant CPU + Redis cost of the strategy-sets stage.
   *
   * Parallelising the individual `saveStrategyToSet` calls would
   * RACE because they all read-modify-write the SAME `setKey`. This
   * batch path avoids the race AND collapses the I/O.
   */
  private async saveBatchToSet(
    setKey: string,
    strategies: Array<{ strategy: any; indicationType: string }>,
    strategyType: string,
  ): Promise<void> {
    if (strategies.length === 0) return
    try {
      const client = await getCachedClient()
      let entries: any[] = []
      const existing = await client.get(setKey)
      if (existing) {
        try { entries = JSON.parse(existing) } catch { entries = [] }
      }

      const baseTs = Date.now()
      for (let i = 0; i < strategies.length; i++) {
        const { strategy, indicationType } = strategies[i]
        entries.push({
          id: `${strategyType}_${baseTs}_${i}_${Math.random().toString(36).slice(2, 6)}`,
          timestamp: new Date().toISOString(),
          profitFactor: strategy.profitFactor,
          confidence: strategy.confidence,
          indicationType,
          strategyType,
          metadata: strategy.metadata,
        })
      }

      const cfg = await this.resolveCompaction(strategyType as keyof StrategySetLimits)
      entries = compact(entries, cfg, "best")

      // Pipeline the writes — the set value and its stats are
      // independent keys so they can flow concurrently.
      const statsKey = `${setKey}:stats`
      const [_, prevStatsRaw] = await Promise.all([
        client.set(setKey, JSON.stringify(entries)),
        getSettings(statsKey),
      ])
      const prevStats = prevStatsRaw || {}
      const stats = {
        maxEntries: cfg.floor,
        currentEntries: entries.length,
        totalCalculated: (prevStats.totalCalculated || 0) + strategies.length,
        totalQualified: (prevStats.totalQualified || 0) + strategies.length,
        avgProfitFactor:
          entries.length > 0
            ? entries.reduce((sum: number, e: any) => sum + e.profitFactor, 0) / entries.length
            : 0,
        lastCalculated: new Date().toISOString(),
      }
      await setSettings(statsKey, stats)

      // Single broadcast per batch — dashboard observers debounce
      // their own re-fetches so emitting N times per cycle would just
      // flood without value.
      if (entries.length > 0) {
        emitStrategyUpdate(this.connectionId, {
          id: entries[0].id,
          symbol: setKey.split(":")[2],
          profit_factor: stats.avgProfitFactor || 0,
          win_rate: strategies[0].strategy?.confidence || 0,
          active_positions: entries.length,
        })
      }
    } catch (error) {
      console.error(`[v0] [StrategySets] Failed to batch-save ${strategies.length} entries to ${setKey}:`, error)
    }
  }

  /**
   * Save strategy to its independent set pool (max 250 entries)
   */
  private async saveStrategyToSet(
    setKey: string,
    strategy: any,
    strategyType: string,
    indicationType: string
  ): Promise<void> {
    try {
      const client = await getCachedClient()
      let entries: any[] = []

      const existing = await client.get(setKey)
      if (existing) {
        try {
          entries = JSON.parse(existing)
        } catch {
          entries = []
        }
      }

      // Newest-at-last (per spec) — use push, not unshift. The "best"
      // compactor below sorts by PF when the buffer crosses the
      // ceiling, so insertion order doesn't strictly matter for
      // correctness, but staying chronological keeps the pre-compaction
      // shape inspectable in admin tools.
      entries.push({
        id: `${strategyType}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        timestamp: new Date().toISOString(),
        profitFactor: strategy.profitFactor,
        confidence: strategy.confidence,
        indicationType,
        strategyType,
        metadata: strategy.metadata,
      })

      // ── Debounced threshold compaction (mode: "best") ────────────────
      // Strategy pools care about *quality* — when the buffer overflows
      // we want to keep the highest-PF entries, not the most recent
      // ones. The compactor stable-sorts by PF desc, keeps the top
      // `floor`, then re-sorts by timestamp ascending so downstream
      // consumers preserve chronological semantics.
      //
      // The pre-existing "sort + slice on every call" pattern was the
      // dominant CPU cost on the strategy pipeline; the new debounced
      // policy only pays the sort once every (ceiling - floor) calls.
      const cfg = await this.resolveCompaction(strategyType as keyof StrategySetLimits)
      entries = compact(entries, cfg, "best")
      const maxEntries = cfg.floor

      // Save back
      await client.set(setKey, JSON.stringify(entries))

      // Update stats
      const statsKey = `${setKey}:stats`
      const prevStats = (await getSettings(statsKey)) || {}
      const stats = {
        maxEntries: maxEntries,
        currentEntries: entries.length,
        totalCalculated: (prevStats.totalCalculated || 0) + 1,
        totalQualified: (prevStats.totalQualified || 0) + 1,
        avgProfitFactor: entries.reduce((sum: number, e: any) => sum + e.profitFactor, 0) / entries.length,
        lastCalculated: new Date().toISOString(),
      }
      await setSettings(statsKey, stats)

      // Broadcast strategy update to connected clients
      emitStrategyUpdate(this.connectionId, {
        id: entries[0].id,
        symbol: setKey.split(':')[2], // Extract symbol from setKey
        profit_factor: strategy.profitFactor || 0,
        win_rate: strategy.confidence || 0,
        active_positions: entries.length,
      })
    } catch (error) {
      console.error(`[v0] [StrategySets] Failed to save to ${setKey}:`, error)
    }
  }

  /**
   * Get stats for a specific strategy type set
   */
  async getSetStats(symbol: string, type: string): Promise<any> {
    try {
      const setKey = `strategy_set:${this.connectionId}:${symbol}:${type}:stats`
      return await getSettings(setKey)
    } catch (error) {
      console.error(`[v0] [StrategySets] Failed to get stats for ${type}:`, error)
      return null
    }
  }

  /**
   * Get all entries from a specific strategy type set
   */
  async getSetEntries(symbol: string, type: string, limit = 50): Promise<any[]> {
    try {
      const client = await getCachedClient()
      const setKey = `strategy_set:${this.connectionId}:${symbol}:${type}`
      const data = await client.get(setKey)

      if (!data) return []

      const entries: any[] = JSON.parse(data)
      // Always return in best-performance-first order
      entries.sort((a: any, b: any) => (b.profitFactor ?? 0) - (a.profitFactor ?? 0))
      return entries.slice(0, limit)
    } catch (error) {
      console.error(`[v0] [StrategySets] Failed to get entries for ${type}:`, error)
      return []
    }
  }
}
