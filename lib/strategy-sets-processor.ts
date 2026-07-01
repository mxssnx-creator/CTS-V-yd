/**
 * Strategy Sets Processor
 * Runs one intervaled Base → Main → Real → Live progression per symbol.
 * Stages are evaluated in a single logical pass and persisted in order while
 * retaining separate per-stage compaction/retention settings.
 * Runs one logical intervaled strategy progression for each symbol.
 * Evaluates candidates once, then persists Base → Main → Real → Live in order.
 * Each stage can still use separate retention and compaction settings, but
 * stages are not separate processing loops.
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

type StrategyBatch = Array<{ strategy: any; indicationType: string }>

export class StrategySetsProcessor {
  private connectionId: string
  private settingsReady: Promise<void>
  private limits: StrategySetLimits = { ...DEFAULT_LIMITS }
  private settingsReady: Promise<void>
  private static readonly MAX_INPUT_MULTIPLIER = 4
  private lastSettingsRefreshAt = 0
  private settingsRefreshInFlight: Promise<void> | null = null
  private readonly SETTINGS_REFRESH_INTERVAL_MS = 5_000
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
      cfg.floor === 250 && legacyLimit > 250
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
      const nextLimits: StrategySetLimits = { ...DEFAULT_LIMITS }

      if (settings) {
        // Load independent limits per type
        if (settings.base) nextLimits.base = Number(settings.base)
        if (settings.main) nextLimits.main = Number(settings.main)
        if (settings.real) nextLimits.real = Number(settings.real)
        if (settings.live) nextLimits.live = Number(settings.live)
        // Fallback: legacy maxEntriesPerSet applies weighted by type.
        if (settings.maxEntriesPerSet && !settings.base) {
          const limit = Number(settings.maxEntriesPerSet)
          nextLimits.base = Math.max(300, Math.round(limit * 1.8))
          nextLimits.main = Math.max(120, Math.round(limit * 0.8))
          nextLimits.real = Math.max(60, Math.round(limit * 0.35))
          nextLimits.live = Math.max(120, limit)
        }
      }

      this.limits = nextLimits
      this.compactionCfgs = {}
      this.lastSettingsRefreshAt = Date.now()
    } catch (error) {
      console.error("[v0] [StrategySets] Failed to load settings:", error)
    }
  }

  private async refreshSettingsIfNeeded(): Promise<void> {
    const now = Date.now()
    if (now - this.lastSettingsRefreshAt < this.SETTINGS_REFRESH_INTERVAL_MS) return

    if (!this.settingsRefreshInFlight) {
      this.settingsRefreshInFlight = this.loadSettings().finally(() => {
        this.settingsRefreshInFlight = null
      })
    }

    await this.settingsRefreshInFlight
  }

  /** Get the limit for a specific strategy type */
  getLimit(type: keyof StrategySetLimits): number {
    return this.limits[type] || DEFAULT_LIMITS[type] || 500
  }

  /**
   * Process the strategy pipeline as one logical progression for a symbol.
   *
   * Base → Main → Real → Live are persisted stage-by-stage so dashboard
   * progress reflects one intervaled pipeline advancing through stages, not
   * four unrelated processors racing each other. Candidate selection is bounded
   * before processing to avoid unbounded prehistoric memory pressure.
   */
  async processAllStrategySets(symbol: string, indications: any[]): Promise<void> {
    try {
      await this.settingsReady

      const startTime = Date.now()
      await this.settingsReady

      // Bound the working set before the staged pipeline runs: prehistoric
      // loads can produce tens of thousands of indications per symbol, but every
      // strategy pool is compacted to a configured floor anyway. Keeping a
      // generous multiple of the largest pool preserves the best candidates
      // while avoiding a full-size clone/sort of the raw indications array.

      const [baseCfg, mainCfg, realCfg, liveCfg] = await Promise.all([
        this.resolveCompaction("base"),
        this.resolveCompaction("main"),
        this.resolveCompaction("real"),
        this.resolveCompaction("live"),
      ])
      const maxLimit = Math.max(
        this.limits.base,
        this.limits.main,
        this.limits.real,
        this.limits.live,
        baseCfg.floor,
        mainCfg.floor,
        realCfg.floor,
        liveCfg.floor,
      )
      const candidateLimit = Math.max(100, maxLimit * StrategySetsProcessor.MAX_INPUT_MULTIPLIER)
      const sortedIndications = this.selectTopCandidates(indications, candidateLimit)

      const results = this.evaluateStrategyPipeline(sortedIndications)
      const rawTotal = indications.length
      const selectedTotal = sortedIndications.length

      await this.saveBatchToSet(`strategy_set:${this.connectionId}:${symbol}:base`, results.base.batch, "base")
      await this.saveBatchToSet(`strategy_set:${this.connectionId}:${symbol}:main`, results.main.batch, "main")
      await this.saveBatchToSet(`strategy_set:${this.connectionId}:${symbol}:real`, results.real.batch, "real")
      await this.saveBatchToSet(`strategy_set:${this.connectionId}:${symbol}:live`, results.live.batch, "live")

      const baseResults = this.toStageResult("base", results.base, rawTotal, selectedTotal)
      const mainResults = this.toStageResult("main", results.main, rawTotal, selectedTotal)
      const realResults = this.toStageResult("real", results.real, rawTotal, selectedTotal)
      const liveResults = this.toStageResult("live", results.live, rawTotal, selectedTotal)
      )
      const candidateLimit = Math.max(100, maxLimit * StrategySetsProcessor.MAX_INPUT_MULTIPLIER)
      const sortedIndications = this.selectTopCandidates(indications, candidateLimit)

      const results = this.evaluateStrategyPipeline(sortedIndications)
      const rawTotal = indications.length
      const selectedTotal = sortedIndications.length

      await this.saveBatchToSet(`strategy_set:${this.connectionId}:${symbol}:base`, results.base.batch, "base")
      await this.saveBatchToSet(`strategy_set:${this.connectionId}:${symbol}:main`, results.main.batch, "main")
      await this.saveBatchToSet(`strategy_set:${this.connectionId}:${symbol}:real`, results.real.batch, "real")
      await this.saveBatchToSet(`strategy_set:${this.connectionId}:${symbol}:live`, results.live.batch, "live")

      const baseResults = this.toStageResult("base", results.base, rawTotal, selectedTotal)
      const mainResults = this.toStageResult("main", results.main, rawTotal, selectedTotal)
      const realResults = this.toStageResult("real", results.real, rawTotal, selectedTotal)
      const liveResults = this.toStageResult("live", results.live, rawTotal, selectedTotal)
        this.limits.base,
        this.limits.main,
        this.limits.real,
        this.limits.live,
      await this.refreshSettingsIfNeeded()

      // Sort indications by profitFactor descending so that the best-performing
      // signals are processed first across all strategy type pools.
      const rawTotal = indications.length
      const sortedIndications = [...indications].sort(
        (a, b) => (b.profitFactor ?? 0) - (a.profitFactor ?? 0)
      )
      const selectedTotal = sortedIndications.length

      // Sort indications by profitFactor descending so that the best-performing
      // signals are processed first across all strategy type pools. Keep enough
      // headroom for the largest resolved compaction floor before the per-pool
      // filters select their own qualifying entries.
      const sortedIndications = [...indications]
        .sort((a, b) => (b.profitFactor ?? 0) - (a.profitFactor ?? 0))
        .slice(0, maxLimit * MAX_INPUT_MULTIPLIER)

      // Process all 4 strategy types in parallel with independent logic
      const [baseResults, mainResults, realResults, liveResults] = await Promise.all([
        this.processBaseStrategySet(symbol, sortedIndications, baseCfg),
        this.processMainStrategySet(symbol, sortedIndications, mainCfg),
        this.processRealStrategySet(symbol, sortedIndications, realCfg),
        this.processLiveStrategySet(symbol, sortedIndications, liveCfg),
        this.processBaseStrategySet(symbol, sortedIndications, rawTotal, selectedTotal),
        this.processMainStrategySet(symbol, sortedIndications, rawTotal, selectedTotal),
        this.processRealStrategySet(symbol, sortedIndications, rawTotal, selectedTotal),
        this.processLiveStrategySet(symbol, sortedIndications, rawTotal, selectedTotal),
      ])

      const duration = Date.now() - startTime
      const totalQualified =
        (baseResults?.qualified || 0) +
        (mainResults?.qualified || 0) +
        (realResults?.qualified || 0) +
        (liveResults?.qualified || 0)

      if (totalQualified > 0) {
        console.log(
          `[v0] [StrategySets] ${symbol}: staged pipeline in ${duration}ms | raw=${rawTotal} selected=${selectedTotal} | Base=${baseResults?.qualified} Main=${mainResults?.qualified} Real=${realResults?.qualified} Live=${liveResults?.qualified}`
          `[v0] [StrategySets] ${symbol}: All types evaluated in ${duration}ms | Raw=${rawTotal} Selected=${selectedTotal} | Base qualified=${baseResults?.qualified} Main qualified=${mainResults?.qualified} Real qualified=${realResults?.qualified} Live qualified=${liveResults?.qualified}`
        )

        await logProgressionEvent(this.connectionId, "strategies_sets", "info", `All strategy types evaluated for ${symbol}`, {
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
   * Keep only the highest profit-factor candidates using a bounded min-heap.
   * This avoids cloning and sorting the entire prehistoric indication set when
   * it is larger than the only portion downstream pools can actually retain.
   */
  private selectTopCandidates(indications: any[], limit: number): any[] {
    if (indications.length <= limit) {
      return [...indications].sort((a, b) => (b.profitFactor ?? 0) - (a.profitFactor ?? 0))
    }

    const heap: any[] = []
    const score = (item: any) => item?.profitFactor ?? 0
    const swap = (a: number, b: number) => {
      const tmp = heap[a]
      heap[a] = heap[b]
      heap[b] = tmp
    }
    const siftUp = (idx: number) => {
      while (idx > 0) {
        const parent = Math.floor((idx - 1) / 2)
        if (score(heap[parent]) <= score(heap[idx])) break
        swap(parent, idx)
        idx = parent
      }
    }
    const siftDown = (idx: number) => {
      for (;;) {
        const left = idx * 2 + 1
        const right = left + 1
        let smallest = idx
        if (left < heap.length && score(heap[left]) < score(heap[smallest])) smallest = left
        if (right < heap.length && score(heap[right]) < score(heap[smallest])) smallest = right
        if (smallest === idx) break
        swap(idx, smallest)
        idx = smallest
      }
    }
  private async processBaseStrategySet(symbol: string, indications: any[], cfg?: CompactionConfig): Promise<any> {
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

    for (const indication of indications) {
      if (heap.length < limit) {
        heap.push(indication)
        siftUp(heap.length - 1)
      } else if (score(indication) > score(heap[0])) {
        heap[0] = indication
        siftDown(0)
      }
    }

    return heap.sort((a, b) => score(b) - score(a))
  }

  private evaluateStrategyPipeline(indications: any[]): Record<keyof StrategySetLimits, { total: number; qualified: number; batch: StrategyBatch }> {
    const result = {
      base: { total: 0, qualified: 0, batch: [] as StrategyBatch },
      main: { total: 0, qualified: 0, batch: [] as StrategyBatch },
      real: { total: 0, qualified: 0, batch: [] as StrategyBatch },
      live: { total: 0, qualified: 0, batch: [] as StrategyBatch },
    }
      }
    }

    return heap.sort((a, b) => score(b) - score(a))
  }

  private evaluateStrategyPipeline(indications: any[]): Record<keyof StrategySetLimits, { total: number; qualified: number; batch: StrategyBatch }> {
    const result = {
      base: { total: 0, qualified: 0, batch: [] as StrategyBatch },
      main: { total: 0, qualified: 0, batch: [] as StrategyBatch },
      real: { total: 0, qualified: 0, batch: [] as StrategyBatch },
      live: { total: 0, qualified: 0, batch: [] as StrategyBatch },
    }
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
    await this.saveBatchToSet(setKey, batch, "base", cfg)
    return { type: "base", total, qualified }
    await this.saveBatchToSet(setKey, batch, "base")
    return this.toStageResult("base", rawTotal, selectedTotal, qualified)
  }

  /**
   * Main Strategy Set - Balanced, medium-risk signals
   */
  private async processMainStrategySet(symbol: string, indications: any[], cfg?: CompactionConfig): Promise<any> {
  private async processMainStrategySet(
    symbol: string,
    indications: any[],
    rawTotal: number,
    selectedTotal: number,
  ): Promise<any> {
    const setKey = `strategy_set:${this.connectionId}:${symbol}:main`
    let qualified = 0

    for (const indication of indications) {
      const confidence = indication.confidence ?? 0
      const profitFactor = indication.profitFactor ?? 0

      result.base.total++
      if (confidence > 0.45 && profitFactor > 0.9) {
      if (indication.confidence > 0.62 && indication.profitFactor > 1.2) {
        const strategy = {
          profitFactor: profitFactor * 0.95,
          confidence,
          metadata: { ...indication.metadata, strategyType: "base", riskLevel: "low" },
        }
        if (strategy.profitFactor >= 1.0) {
          result.base.qualified++
          result.base.batch.push({ strategy, indicationType: indication.type })
        }
      }

      result.main.total++
      if (confidence > 0.62 && profitFactor > 1.2) {
        const strategy = {
          profitFactor,
          confidence,
          metadata: { ...indication.metadata, strategyType: "main", riskLevel: "medium" },
        }
        result.main.qualified++
        result.main.batch.push({ strategy, indicationType: indication.type })
      }

      result.main.total++
      if (confidence > 0.62 && profitFactor > 1.2) {
        const strategy = {
          profitFactor,
          confidence,
          metadata: { ...indication.metadata, strategyType: "main", riskLevel: "medium" },
        }
        result.main.qualified++
        result.main.batch.push({ strategy, indicationType: indication.type })
      }

      result.real.total++
      if (confidence > 0.78 && profitFactor > 1.45) {

      result.real.total++
      if (confidence > 0.78 && profitFactor > 1.45) {
    }
    await this.saveBatchToSet(setKey, batch, "main", cfg)
    return { type: "main", total, qualified }
    await this.saveBatchToSet(setKey, batch, "main")
    return this.toStageResult("main", rawTotal, selectedTotal, qualified)
  }

  /**
   * Real Strategy Set - Aggressive, higher-risk signals
   */
  private async processRealStrategySet(symbol: string, indications: any[], cfg?: CompactionConfig): Promise<any> {
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
          profitFactor: profitFactor * 1.1,
          confidence,
          metadata: { ...indication.metadata, strategyType: "real", riskLevel: "high" },
        }
        result.real.qualified++
        result.real.batch.push({ strategy, indicationType: indication.type })
      }

      result.live.total++
      if (profitFactor >= 1.0) {

      result.live.total++
      if (profitFactor >= 1.0) {
    }
    await this.saveBatchToSet(setKey, batch, "real", cfg)
    return { type: "real", total, qualified }
    await this.saveBatchToSet(setKey, batch, "real")
    return this.toStageResult("real", rawTotal, selectedTotal, qualified)
  }

  /**
   * Live Strategy Set - All qualifying signals, real-time only
   */
  private async processLiveStrategySet(symbol: string, indications: any[], cfg?: CompactionConfig): Promise<any> {
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
          profitFactor,
          confidence,
          metadata: { ...indication.metadata, strategyType: "live", riskLevel: "variable" },
        }
        result.live.qualified++
        result.live.batch.push({ strategy, indicationType: indication.type })
      }
    }

    return result
  }

  private toStageResult(type: keyof StrategySetLimits, stage: { total: number; qualified: number }, rawTotal: number, selectedTotal: number): any {
    return { type, total: rawTotal, rawTotal, selectedTotal, evaluated: stage.total, qualified: stage.qualified }
    await this.saveBatchToSet(setKey, batch, "live", cfg)
    return { type: "live", total, qualified }
    await this.saveBatchToSet(setKey, batch, "live")
    return this.toStageResult("live", rawTotal, selectedTotal, qualified)
  }

  /**
   * Batch-save multiple qualifying strategies to the same set pool in
   * ONE read-merge-compact-write transaction.
   * Batch-save all qualifying strategies for a type-specific pool in one
   * staged read-merge-compact-write transaction. The strategy-set pipeline
   * accumulates qualifying entries in memory while evaluating indications,
   * then writes the staged batch once per strategy type to avoid repeated
   * Redis I/O and read-modify-write races on the same key.
   */
  private async saveBatchToSet(
    setKey: string,
    strategies: Array<{ strategy: any; indicationType: string }>,
    strategyType: string,
    resolvedCfg?: CompactionConfig,
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

      const cfg = resolvedCfg ?? (await this.resolveCompaction(strategyType as keyof StrategySetLimits))
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
