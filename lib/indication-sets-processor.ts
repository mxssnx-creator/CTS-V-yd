/**
 * Independent Indication Sets Processor
 *
 * ── Design Principles ─────────────────────────────────────────────────
 *  1. Each indication TYPE (direction, move, active, optimal,
 *     active_advanced) has independent sets.
 *  2. Each CONFIG/parameter combination within a type has its OWN set.
 *  3. Each set is keyed `indication_set:{connId}:{symbol}:{type}:{configHash}`.
 *  4. Max positions per direction (long/short) is enforced per config.
 *  5. Indication timeout is applied after valid evaluation.
 *
 * ── 250-entry cap is PER-SET, not per-type total ─────────────────────
 * The constant `DEFAULT_LIMITS[type]` (250 by default) caps the number
 * of historical entries stored INSIDE a single Set (i.e. inside one
 * Redis key). It is NOT a cap on:
 *   - the total number of Sets per type (that's bounded by the number
 *     of valid config combinations)
 *   - the total entries across all Sets of a type (sum across keys)
 *   - cycle / frame / tick counters (those are unbounded counters
 *     stored on `progression:{connId}` independently of this cap)
 *
 * The cap is applied inside `batchSaveIndications` / `saveIndicationToSet`
 * via the shared compaction policy (`lib/sets-compaction.ts`), which
 * runs only when the buffer crosses `floor × (1 + thresholdPct/100)`
 * — default 250 × 1.2 = 300. Older entries are dropped first
 * (newest-at-last invariant). The Settings → System → "Set Compaction"
 * card lets the operator tune `floor`, `thresholdPct`, and per-type
 * overrides.
 */

import { getRedisClient, initRedis, getSettings, getAppSettings, setSettings } from "@/lib/redis-db"
import { logProgressionEvent } from "@/lib/engine-progression-logs"
import { emitIndicationUpdate } from "@/lib/broadcast-helpers"
import {
  compactionCeiling,
  loadCompactionConfig,
  type CompactionConfig,
  type SetCompactionType,
} from "@/lib/sets-compaction"

// Default limits per indication type (independently configurable)
const DEFAULT_LIMITS = {
  direction: 250,
  move: 250,
  active: 250,
  optimal: 250,
  active_advanced: 250,
}

// Pre-cached client reference
let cachedClient: any = null
async function getCachedClient() {
  // Always re-check if cachedClient is null/undefined
  if (!cachedClient) {
    await initRedis()
    cachedClient = getRedisClient()
  }
  // If still null after init, throw a clear error
  if (!cachedClient) {
    throw new Error("[IndicationSets] Redis client not available after initialization")
  }
  return cachedClient
}

// Position limits per config per direction
const DEFAULT_POSITION_LIMITS = {
  maxLong: 1,
  maxShort: 1,
}

// Indication timeout after valid evaluation (100ms - 3000ms)
const DEFAULT_INDICATION_TIMEOUT_MS = 1000

const DEFAULT_OUTCOME_ATTACHMENT_CONCURRENCY = 20

const RECORD_OUTCOME_SAMPLE_SCRIPT = `
local sampleKey = KEYS[1]
local statsKey = KEYS[2]
local sampleJson = ARGV[1]
local sampleProfit = tonumber(ARGV[2]) or 0
local sampleLoss = tonumber(ARGV[3]) or 0
local cap = tonumber(ARGV[4]) or 1000

redis.call("RPUSH", sampleKey, sampleJson)
local len = redis.call("LLEN", sampleKey)
local overflow = len - cap
local evictedProfit = 0
local evictedLoss = 0
local evictedCount = 0

if overflow > 0 then
  local evicted = redis.call("LRANGE", sampleKey, 0, overflow - 1)
  for _, raw in ipairs(evicted) do
    local ok, decoded = pcall(cjson.decode, raw)
    if ok and type(decoded) == "table" then
      evictedProfit = evictedProfit + math.max(tonumber(decoded["profit"]) or 0, 0)
      evictedLoss = evictedLoss + math.max(tonumber(decoded["loss"]) or 0, 0)
      evictedCount = evictedCount + 1
    end
  end
  redis.call("LTRIM", sampleKey, -cap, -1)
end

local grossProfit = tonumber(redis.call("HGET", statsKey, "grossProfit"))
local grossLoss = tonumber(redis.call("HGET", statsKey, "grossLoss"))
local count = tonumber(redis.call("HGET", statsKey, "count"))

if grossProfit == nil or grossLoss == nil or count == nil or grossProfit < 0 or grossLoss < 0 or count < 0 then
  grossProfit = 0
  grossLoss = 0
  count = 0
  local samples = redis.call("LRANGE", sampleKey, 0, -1)
  for _, raw in ipairs(samples) do
    local ok, decoded = pcall(cjson.decode, raw)
    if ok and type(decoded) == "table" then
      grossProfit = grossProfit + math.max(tonumber(decoded["profit"]) or 0, 0)
      grossLoss = grossLoss + math.max(tonumber(decoded["loss"]) or 0, 0)
      count = count + 1
    end
  end
else
  grossProfit = math.max(grossProfit + sampleProfit - evictedProfit, 0)
  grossLoss = math.max(grossLoss + sampleLoss - evictedLoss, 0)
  count = math.max(count + 1 - evictedCount, 0)
end

redis.call("HSET", statsKey, "grossProfit", tostring(grossProfit), "grossLoss", tostring(grossLoss), "count", tostring(count))
return { tostring(grossProfit), tostring(grossLoss), tostring(count) }
`

type IndicationCandidate = { setKey: string; indication: any; config: any }

async function mapLimit<T, R>(items: T[], limit: number, mapper: (item: T, index: number) => Promise<R>): Promise<R[]> {
  if (items.length === 0) return []

  const concurrency = Math.max(1, Math.min(Math.floor(limit) || 1, items.length))
  const results = new Array<R>(items.length)
  let nextIndex = 0

  async function worker(): Promise<void> {
    while (nextIndex < items.length) {
      const index = nextIndex++
      results[index] = await mapper(items[index], index)
    }
  }

  await Promise.all(Array.from({ length: concurrency }, () => worker()))
  return results
}

export interface IndicationSetLimits {
  direction: number
  move: number
  active: number
  optimal: number
  active_advanced: number
}

export interface PositionLimits {
  maxLong: number
  maxShort: number
}

export interface IndicationSet {
  type: "direction" | "move" | "active" | "optimal" | "active_advanced"
  connectionId: string
  symbol: string
  configKey: string // Unique key for this configuration combination
  entries: Array<{
    id: string
    timestamp: Date
    profitFactor: number
    signalScore?: number
    rawSignalStrength?: number
    confidence: number
    config: any
    metadata: any
    direction: "long" | "short"
  }>
  maxEntries: number // Configurable per type, default 250
  positionCounts: {
    long: number
    short: number
  }
  stats: {
    totalCalculated: number
    totalQualified: number
    avgProfitFactor: number
    lastCalculated: Date | null
  }
}

export class IndicationSetsProcessor {
  private connectionId: string
  private sets: Map<string, IndicationSet> = new Map()
  private limits: IndicationSetLimits = { ...DEFAULT_LIMITS }
  private positionLimits: PositionLimits = { ...DEFAULT_POSITION_LIMITS }
  private indicationTimeoutMs: number = DEFAULT_INDICATION_TIMEOUT_MS
  /**
   * Per-type compaction config, resolved once per ~5s via the cached
   * `loadCompactionConfig` helper. Keeping a per-processor copy lets the
   * hot-path append helper enforce compaction without touching the settings
   * hash on every fill.
   */
  private compactionCfgs: Partial<Record<SetCompactionType, CompactionConfig>> = {}
  // Dev mode uses a minimal range grid so the 4-GB v0 sandbox VM can run the
  // full indication → strategy → live pipeline without OOM.
  //   Full grid: 29 ranges × 3 dd × 2 lp × 3 fm = 522 keys/type/symbol
  //              × 5 types × 3 symbols = 7,830 keys/cycle → accumulates fast
  //   Dev  grid:  3 ranges × 2 dd × 1 lp × 2 fm = 12  keys/type/symbol
  //              × 5 types × 3 symbols = 180 keys/cycle — easily evictable
  private directionMoveRanges: number[] = Array.from({ length: 29 }, (_, i) => i + 2) // 2..30
  private optimalRanges: number[] = Array.from({ length: 29 }, (_, i) => i + 2)
  private drawdownRatios: number[] = [0.5, 1.0, 1.5]
  private lastPartRatios: number[] = [0.25, 0.5]
  private factorMultipliers: number[] = [0.9, 1.0, 1.1]
  private activeThresholds: number[] = [0.5, 1.0, 1.5, 2.0, 2.5]
  private activeTimeRatios: number[] = [0.5, 1.0]
  private activeAdvancedActivityRatios: number[] = [0.5, 1.0, 1.5, 2.0, 2.5, 3.0]
  private activeAdvancedMinPositions = 3
  private activeAdvancedContinuationRatio = 0.6
  private shortPriceHistoryWarnings: Set<string> = new Set()
  private outcomeHorizonCandles = 12
  private outcomeTakeProfitPct = 0.01
  private outcomeStopLossPct = 0.01
  private outcomeTakerFeePct = 0.001
  private outcomeSlippagePct = 0.0006
  private outcomeAttachmentConcurrency = DEFAULT_OUTCOME_ATTACHMENT_CONCURRENCY

  constructor(connectionId: string) {
    this.connectionId = connectionId
    this.loadSettings()
  }

  private getSetIndexKeys(symbol: string, type: string): string[] {
    return [
      `indication_sets:index:${this.connectionId}`,
      `indication_sets:index:${this.connectionId}:${symbol}`,
      `indication_sets:index:${this.connectionId}:${symbol}:${type}`,
    ]
  }

  private async indexSetKey(client: any, setKey: string, symbol: string, type: string): Promise<void> {
    const indexes = this.getSetIndexKeys(symbol, type)
    const pipeline = client.multi()
    for (const indexKey of indexes) pipeline.sadd(indexKey, setKey)
    await pipeline.exec().catch(() => {})
  }

  private async getIndexedSetKeys(client: any, symbol: string, type: string): Promise<string[]> {
    const typeIndexKey = `indication_sets:index:${this.connectionId}:${symbol}:${type}`
    let keys = ((await client.smembers(typeIndexKey).catch(() => [])) || []) as string[]
    if (keys.length > 0) return keys

    // Startup/repair fallback only: bounded SCAN is used to backfill the
    // maintained per-connection/per-symbol/per-type indexes for legacy keys.
    // Dashboard polling paths normally read only the index set above.
    const prefix = `indication_set:${this.connectionId}:${symbol}:${type}`
    if (typeof client.scan !== "function") return keys
    let cursor = "0"
    do {
      const result = await client.scan(cursor, "MATCH", `${prefix}*`, "COUNT", 100).catch(() => null)
      if (!result) break
      cursor = String(result[0] ?? "0")
      keys.push(...((result[1] || []) as string[]))
    } while (cursor !== "0")

    if (keys.length > 0) {
      const pipeline = client.multi()
      for (const setKey of keys) {
        for (const indexKey of this.getSetIndexKeys(symbol, type)) pipeline.sadd(indexKey, setKey)
      }
      await pipeline.exec().catch(() => {})
    }
    return keys
  }

  private async loadSettings(): Promise<void> {
    try {
      // Mirror-aware read so operator values saved via the UI
      // (`app_settings`) apply even if the legacy `all_settings` hash
      // is empty on a fresh install.
      const settings = await getAppSettings()
      if (settings && Object.keys(settings).length > 0) {
        // Load independent limits per type
        if (settings.databaseSizeDirection) this.limits.direction = Number(settings.databaseSizeDirection)
        if (settings.databaseSizeMove) this.limits.move = Number(settings.databaseSizeMove)
        if (settings.databaseSizeActive) this.limits.active = Number(settings.databaseSizeActive)
        if (settings.databaseSizeOptimal) this.limits.optimal = Number(settings.databaseSizeOptimal)
        
        // Load position limits per direction
        if (settings.maxPositionsLong) this.positionLimits.maxLong = Number(settings.maxPositionsLong)
        if (settings.maxPositionsShort) this.positionLimits.maxShort = Number(settings.maxPositionsShort)
        
        // Load indication timeout
        if (settings.indicationTimeoutMs) {
          this.indicationTimeoutMs = Math.max(100, Math.min(3000, Number(settings.indicationTimeoutMs)))
        }

        // Config-grid controls (optional)
        this.directionMoveRanges = this.parseRangeSettings(
          settings.directionRangeStart,
          settings.directionRangeEnd,
          settings.directionRangeStep,
          this.directionMoveRanges,
        )
        this.optimalRanges = this.parseRangeSettings(
          settings.optimalRangeStart,
          settings.optimalRangeEnd,
          settings.optimalRangeStep,
          this.optimalRanges,
        )
        this.drawdownRatios = this.parseNumericList(settings.indicationDrawdownRatios, this.drawdownRatios)
        this.lastPartRatios = this.parseNumericList(settings.indicationLastPartRatios, this.lastPartRatios)
        this.factorMultipliers = this.parseNumericList(settings.indicationFactorMultipliers, this.factorMultipliers)
        this.activeThresholds = this.parseNumericList(settings.activeThresholds, this.activeThresholds)
        this.activeTimeRatios = this.parseNumericList(settings.activeTimeRatios, this.activeTimeRatios)
        const activeAdvanced = settings.active_advanced || settings.activeAdvanced || {}
        this.activeAdvancedActivityRatios = this.parseRangeObject(
          activeAdvanced.activity_ratios || settings.activeAdvancedActivityRatios,
          this.activeAdvancedActivityRatios,
        )
        this.activeAdvancedMinPositions = Math.max(
          2,
          Math.round(this.parsePositiveNumber(activeAdvanced.min_positions ?? settings.activeAdvancedMinPositions, this.activeAdvancedMinPositions)),
        )
        this.activeAdvancedContinuationRatio = Math.max(
          0,
          Math.min(1, this.parsePositiveNumber(activeAdvanced.continuation_ratio ?? settings.activeAdvancedContinuationRatio, this.activeAdvancedContinuationRatio)),
        )
        this.outcomeHorizonCandles = this.parsePositiveNumber(settings.indicationOutcomeHorizonCandles, this.outcomeHorizonCandles)
        this.outcomeTakeProfitPct = this.parsePositiveNumber(settings.indicationOutcomeTakeProfitPct, this.outcomeTakeProfitPct)
        this.outcomeStopLossPct = this.parsePositiveNumber(settings.indicationOutcomeStopLossPct, this.outcomeStopLossPct)
        this.outcomeTakerFeePct = this.parseNonNegativeNumber(settings.indicationOutcomeTakerFeePct, this.outcomeTakerFeePct)
        this.outcomeSlippagePct = this.parseNonNegativeNumber(settings.indicationOutcomeSlippagePct ?? settings.slippageTolerance, this.outcomeSlippagePct)
        this.outcomeAttachmentConcurrency = Math.max(1, Math.min(50, Math.round(this.parsePositiveNumber(settings.indicationOutcomeAttachmentConcurrency, this.outcomeAttachmentConcurrency))))
        
        // Fallback: legacy maxEntriesPerSet applies to all
        if (settings.maxEntriesPerSet && !settings.databaseSizeDirection) {
          const limit = Number(settings.maxEntriesPerSet)
          this.limits = { direction: limit, move: limit, active: limit, optimal: limit, active_advanced: limit }
        }
      }
      
      // Also load from indication_sets_config for backward compatibility
      const setsConfig = await getSettings("indication_sets_config")
      if (setsConfig) {
        if (setsConfig.direction) this.limits.direction = Number(setsConfig.direction)
        if (setsConfig.move) this.limits.move = Number(setsConfig.move)
        if (setsConfig.active) this.limits.active = Number(setsConfig.active)
        if (setsConfig.active_advanced) this.limits.active_advanced = Number(setsConfig.active_advanced)
        if (setsConfig.optimal) this.limits.optimal = Number(setsConfig.optimal)
      }
    } catch (error) {
      console.error("[v0] [IndicationSets] Failed to load settings:", error)
    }
  }

  /** Get the limit for a specific indication type */
  getLimit(type: keyof IndicationSetLimits): number {
    return this.limits[type] || DEFAULT_LIMITS[type] || 250
  }

  /**
   * Resolve the compaction config for an indication-set pool.
   *
   * Falls back to the legacy per-type `getLimit()` value as the floor
   * when no operator-level setting is configured, so behaviour stays
   * identical for users who haven't touched the new Set Compaction card.
   * Threshold defaults to 20% per spec.
   *
   * Cached on the processor instance — refreshed lazily via the 5s TTL
   * inside `loadCompactionConfig`.
   */
  private async resolveCompaction(
    type: keyof IndicationSetLimits,
  ): Promise<CompactionConfig> {
    const ckey = `indication.${type}` as SetCompactionType
    const cached = this.compactionCfgs[ckey]
    if (cached) return cached
    const cfg = await loadCompactionConfig(ckey)
    // If the operator never set a global / per-type floor, the helper
    // returned the hard-coded 250 default. For indication pools we want
    // the type-specific legacy limit (which may differ from 250 if the
    // user customised it under Settings → Indications → Sets) to win
    // over the global default — so we bump the floor up only when the
    // user hasn't explicitly overridden it via the new Set Compaction
    // card. Detection is heuristic: if the resolved floor matches the
    // hard-coded default *and* the legacy limit is larger, prefer the
    // legacy limit.
    const legacyLimit = this.getLimit(type)
    const finalCfg: CompactionConfig =
      cfg.floor === 250 && legacyLimit > 250
        ? { floor: legacyLimit, thresholdPct: cfg.thresholdPct }
        : cfg
    this.compactionCfgs[ckey] = finalCfg
    return finalCfg
  }

  /**
   * Append one or more entries to an indication-set Redis LIST.
   *
   * The previous implementation performed GET → JSON.parse → push → SET for
   * every write, so concurrent writers could overwrite each other. Lists let
   * Redis perform the append server-side with RPUSH. We only LTRIM when the
   * post-push length crosses the configured compaction ceiling, preserving the
   * same "grow to floor + threshold%, then compact back to floor" policy and
   * the newest-at-last ordering required by downstream readers.
   */
  private async appendIndicationEntries(
    client: any,
    setKey: string,
    serializedEntries: string[],
    cfg: CompactionConfig,
  ): Promise<number> {
    if (serializedEntries.length === 0) return 0
    let length: number
    try {
      length = await client.rpush(setKey, ...serializedEntries)
    } catch {
      // Migration path for legacy JSON-array keys. Convert once by reading the
      // string, deleting it, and recreating the same key as a Redis LIST.
      const legacy = await this.readIndicationSetEntries(client, setKey)
      await client.del(setKey)
      const migrated = [...legacy.map((entry) => JSON.stringify(entry)), ...serializedEntries]
      length = migrated.length > 0 ? await client.rpush(setKey, ...migrated) : 0
    }
    if (length >= compactionCeiling(cfg)) {
      await client.ltrim(setKey, -cfg.floor, -1)
      return Math.min(length, cfg.floor)
    }
    return length
  }

  private async readIndicationSetEntries(client: any, setKey: string): Promise<any[]> {
    try {
      const listValues: string[] = await client.lrange(setKey, 0, -1)
      if (Array.isArray(listValues) && listValues.length > 0) {
        return listValues
          .map((raw) => {
            try { return JSON.parse(raw) } catch { return null }
          })
          .filter(Boolean)
      }
    } catch {
      // Legacy keys are JSON strings; real Redis raises WRONGTYPE for LRANGE.
    }

    try {
      const raw = await client.get(setKey)
      if (!raw) return []
      const entries = JSON.parse(raw as string)
      return Array.isArray(entries) ? entries : []
    } catch {
      return []
    }
  }

  private parseRangeSettings(startRaw: any, endRaw: any, stepRaw: any, fallback: number[]): number[] {
    const start = Number(startRaw)
    const end = Number(endRaw)
    const step = Number(stepRaw)
    if (!Number.isFinite(start) || !Number.isFinite(end) || !Number.isFinite(step) || step <= 0 || end < start) {
      return fallback
    }
    const values: number[] = []
    for (let v = start; v <= end; v += step) values.push(v)
    return values.length > 0 ? values : fallback
  }

  private parsePositiveNumber(raw: any, fallback: number): number {
    const value = Number(raw)
    return Number.isFinite(value) && value > 0 ? value : fallback
  }

  private parseNonNegativeNumber(raw: any, fallback: number): number {
    const value = Number(raw)
    return Number.isFinite(value) && value >= 0 ? value : fallback
  }

  private parseNumericList(raw: any, fallback: number[]): number[] {
    if (Array.isArray(raw)) {
      const parsed = raw.map((v) => Number(v)).filter((v) => Number.isFinite(v))
      return parsed.length > 0 ? parsed : fallback
    }
    if (typeof raw === "string") {
      const parsed = raw
        .split(",")
        .map((v) => Number(v.trim()))
        .filter((v) => Number.isFinite(v))
      return parsed.length > 0 ? parsed : fallback
    }
    return fallback
  }

  private parseRangeObject(raw: any, fallback: number[]): number[] {
    if (raw && typeof raw === "object" && !Array.isArray(raw)) {
      return this.parseRangeSettings(raw.from, raw.to, raw.step, fallback)
    }
    return this.parseNumericList(raw, fallback)
  }
  
  /** Get position limits */
  getPositionLimits(): PositionLimits {
    return this.positionLimits
  }
  
  /** Check if we can add a position for given direction */
  canAddPosition(configKey: string, direction: "long" | "short", currentCount: number): boolean {
    const limit = direction === "long" ? this.positionLimits.maxLong : this.positionLimits.maxShort
    return currentCount < limit
  }
  
  /**
   * Process all indication types independently for a symbol
   */
  async processAllIndicationSets(symbol: string, marketData: any): Promise<void> {
    const startTime = Date.now()
    const TIMEOUT_MS = 15000 // 15 second timeout per symbol
    
    try {
      await this.closePendingRealtimeOutcomes(symbol, marketData)
      if (!marketData) {
        console.warn(`[v0] [IndicationSets] Invalid market data for ${symbol}`)
        await logProgressionEvent(this.connectionId, "indications_sets", "warning", `Invalid market data for ${symbol}`, {
          symbol,
          reason: "null_market_data",
        })
        return
      }

      const priceHistory = this.normalizePriceHistory(marketData)
      const hasEnoughHistory = await this.warnIfPriceHistoryTooShort(symbol, marketData, priceHistory.length)
      if (!hasEnoughHistory) {
        // Warm-up ticks can arrive every few hundred milliseconds while the
        // rolling history is still below the largest configured range. Running
        // all Set calculators during that period produces no complete Sets and
        // can monopolize the API worker in production. Return after the
        // throttled warning so status/health endpoints remain responsive while
        // history fills naturally.
        return
      }

      const apiSetFillEnabled =
        process.env.NODE_ENV !== "production" ||
        process.env.ENABLE_API_INDICATION_SET_FILL === "1" ||
        process.env.ENABLE_API_INDICATION_SET_FILL === "true"
      if (!apiSetFillEnabled) {
        return
      }

      // Process all 5 set-backed types in parallel with independent logic.
      // Use per-type isolation so an Optimal/Auto calculation failure never
      // aborts Direction/Move/Active for the same symbol and never crashes the
      // whole progression cycle.
      const runType = async (type: string, fn: () => Promise<any>) => {
        try {
          return await fn()
        } catch (error) {
          console.warn(
            `[v0] [IndicationSets] ${symbol}:${type} failed:`,
            error instanceof Error ? error.message : String(error),
          )
          await logProgressionEvent(this.connectionId, "indications_sets", "error", `${type} indication failed for ${symbol}`, {
            symbol,
            type,
            error: error instanceof Error ? error.message : String(error),
          }).catch(() => {})
          return { type, total: 0, qualified: 0, configs: 0, error: true }
        }
      }
      const [directionResults, moveResults, activeResults, activeAdvancedResults, optimalResults] = await Promise.all([
        runType("direction", () => this.processDirectionSet(symbol, marketData)),
        runType("move", () => this.processMoveSet(symbol, marketData)),
        runType("active", () => this.processActiveSet(symbol, marketData)),
        runType("active_advanced", () => this.processActiveAdvancedSet(symbol, marketData)),
        runType("optimal", () => this.processOptimalSet(symbol, marketData)),
      ])

      const duration = Date.now() - startTime
      
      // Check for timeout
      if (duration > TIMEOUT_MS) {
        console.warn(`[v0] [IndicationSets] TIMEOUT: Processing exceeded ${TIMEOUT_MS}ms for ${symbol} (took ${duration}ms)`)
        await logProgressionEvent(this.connectionId, "indications_sets", "warning", `Indication set processing timeout for ${symbol}`, {
          symbol,
          timeoutMs: TIMEOUT_MS,
          actualMs: duration,
        })
        return
      }

      const totalQualified = 
        (directionResults?.qualified || 0) +
        (moveResults?.qualified || 0) +
        (activeResults?.qualified || 0) +
        (activeAdvancedResults?.qualified || 0) +
        (optimalResults?.qualified || 0)

      // ── ACTIVE-VALID indication snapshot (per cycle, per (symbol, type)) ──
      // The legacy `:count` keys are CUMULATIVE (hincrby every commit). The
      // dashboard "Overview" needs a *current* count: how many indications of
      // each type are passing their thresholds RIGHT NOW. We overwrite a
      // single hash field per (symbol, type) on every cycle so the most
      // recent qualified count for that pair is always the one read.
      //
      //   indication_sets_active:{connectionId} → hash
      //     fields: "{symbol}:direction", "{symbol}:move", "{symbol}:active",
      //             "{symbol}:active_advanced", "{symbol}:optimal"
      //
      // Detailed set tracking hgetalls this hash and aggregates by type — fields are
      // O(symbols × types) total which is small (≤ 5 × 5 = 25 fields). TTL
      // is short so a stopped engine doesn't leave stale "active" rows
      // forever; the next cycle naturally refreshes them.
      try {
        const { getRedisClient: _getRedis } = await import("@/lib/redis-db")
        const client = _getRedis()
        const activeKey = `indication_sets_active:${this.connectionId}`
        await client.hset(activeKey, {
          [`${symbol}:direction`]:       String(directionResults?.qualified ?? 0),
          [`${symbol}:move`]:            String(moveResults?.qualified      ?? 0),
          [`${symbol}:active`]:          String(activeResults?.qualified    ?? 0),
          [`${symbol}:active_advanced`]: String(activeAdvancedResults?.qualified ?? 0),
          [`${symbol}:optimal`]:         String(optimalResults?.qualified   ?? 0),
        })
        await client.expire(activeKey, 600) // 10 min — engine refreshes each cycle

        // ── Windowed indication counts ────────────────────────────────────
        // Write/refresh per-type counts into the two windowed hashes that
        // getIndicationTracking reads for "Last 5" and "Last 60 min" panels.
        // Fields are symbol-prefixed and overwritten with the latest value for
        // each symbol/type. Production runs can process overlapping cycles;
        // HINCRBY on plain type fields made non-direction counts drift upward
        // with every retry/overlap instead of reflecting the current window.
        // Per-symbol HSET keeps sibling symbols independent and idempotent.
        const progKey    = `progression:${this.connectionId}`
        const w5Key      = `indication_sets_window:${this.connectionId}:last5`
        const w60Key     = `indication_sets_window:${this.connectionId}:last60min`
        const dirQ  = directionResults?.qualified  ?? 0
        const moveQ = moveResults?.qualified       ?? 0
        const actQ  = activeResults?.qualified     ?? 0
        const advQ  = activeAdvancedResults?.qualified ?? 0
        const optQ  = optimalResults?.qualified    ?? 0
        const pipe = client.multi()
        pipe.hset(w5Key, {
          [`${symbol}:direction`]: String(dirQ),
          [`${symbol}:move`]: String(moveQ),
          [`${symbol}:active`]: String(actQ),
          [`${symbol}:active_advanced`]: String(advQ),
          [`${symbol}:optimal`]: String(optQ),
        })
        pipe.expire(w5Key,   300) // 5 min rolling window
        pipe.hset(w60Key, {
          [`${symbol}:direction`]: String(dirQ),
          [`${symbol}:move`]: String(moveQ),
          [`${symbol}:active`]: String(actQ),
          [`${symbol}:active_advanced`]: String(advQ),
          [`${symbol}:optimal`]: String(optQ),
        })
        pipe.expire(w60Key,  4200) // 70 min rolling window
        if (dirQ > 0 || moveQ > 0 || actQ > 0 || advQ > 0 || optQ > 0) {
          // Total indication Sets active this cycle: configs that qualified across
          // all types. Stored as a progression field so getIndicationTracking has
          // a non-zero totalIndicationSets without a separate keys() scan.
          const totalSetsThisCycle = (directionResults?.configs ?? dirQ) +
                                     (moveResults?.configs      ?? moveQ) +
                                     (activeResults?.configs    ?? actQ) +
                                     (activeAdvancedResults?.configs ?? advQ) +
                                     (optimalResults?.configs   ?? optQ)
          if (totalSetsThisCycle > 0) {
            pipe.hincrby(progKey, "indication_sets_total", totalSetsThisCycle)
          }
        }
        await pipe.exec().catch(() => {})
      } catch { /* non-critical: dashboard falls back to cumulative */ }

      if (totalQualified > 0) {
        // Throttle console log to once per 60 s per symbol.
        // During historical replay a single cycle runs up to 30 steps; each
        // step calls processAllIndicationSets and would emit this line, producing
        // 30+ identical lines per symbol per cycle. One line per minute is enough.
        const throttleKey = `${symbol}:${this.connectionId}`
        const lastLogBucket = (this as any)._setsLogBucket
        const nowBucket = Math.floor(Date.now() / 60_000)
        if (!lastLogBucket || lastLogBucket[throttleKey] !== nowBucket) {
          if (!(this as any)._setsLogBucket) (this as any)._setsLogBucket = {}
          ;(this as any)._setsLogBucket[throttleKey] = nowBucket
          console.log(
            `[v0] [IndicationSets] ${symbol}: COMPLETE in ${duration}ms | Direction=${directionResults?.qualified}/${directionResults?.total} Move=${moveResults?.qualified}/${moveResults?.total} Active=${activeResults?.qualified}/${activeResults?.total} ActiveAdvanced=${activeAdvancedResults?.qualified}/${activeAdvancedResults?.total} Optimal=${optimalResults?.qualified}/${optimalResults?.total}`
          )
        }

        // Also throttle the Redis progression event — same 60s bucket.
        if ((this as any)._setsLogBucket?.[throttleKey] === nowBucket) {
          await logProgressionEvent(this.connectionId, "indications_sets", "info", `All indication types processed for ${symbol}`, {
            direction: directionResults,
            move: moveResults,
            active: activeResults,
            active_advanced: activeAdvancedResults,
            optimal: optimalResults,
            duration,
          })
        }
      }
    } catch (error) {
      console.error(`[v0] [IndicationSets] Failed to process sets for ${symbol}:`, error)
    }
  }

  private async attachQualifiedCandidates(
    symbol: string,
    marketData: any,
    candidates: IndicationCandidate[],
  ): Promise<IndicationCandidate[]> {
    const attached = await mapLimit(candidates, this.outcomeAttachmentConcurrency, async (candidate) => {
      const profitFactor = await this.attachOutcomeBackedProfitFactor(
        symbol,
        marketData,
        candidate.setKey,
        candidate.indication,
      )
      return profitFactor >= 1.0 ? candidate : null
    })

    return attached.filter((candidate): candidate is IndicationCandidate => candidate !== null)
  }

  /**
   * Process Direction Indication Set (ranges 2-30)
   * OPTIMIZED: Process all ranges in batch, minimize Redis calls
   */
  private async processDirectionSet(symbol: string, marketData: any): Promise<any> {
    const keyRanges = this.directionMoveRanges
    const drawdownRatios = this.drawdownRatios
    const lastPartRatios = this.lastPartRatios
    const factorMultipliers = this.factorMultipliers
    let qualified = 0
    let total = 0
    const candidates: IndicationCandidate[] = []

    for (const range of keyRanges) {
      for (const drawdownRatio of drawdownRatios) {
        for (const lastPartRatio of lastPartRatios) {
          for (const factorMultiplier of factorMultipliers) {
            const indication = this.calculateDirectionIndication(marketData, {
              range,
              drawdownRatio,
              lastPartRatio,
              factorMultiplier,
            })
            if (!indication) continue
            
            total++
            // Derive direction from the actual signal — firstDir > 0 means long,
            // firstDir < 0 means short. This MUST be computed BEFORE building the
            // set key so long and short signals write to INDEPENDENT Redis keys.
            const direction = indication.metadata?.firstDir > 0 ? "long" : "short"
            indication.direction = direction
            // Key includes direction so long/short never share the same Redis key.
            // Without :dir the same config combo for both directions overwrites each
            // other's JSON array, producing identical (wrong) values for L and S.
            const setKey = `indication_set:${this.connectionId}:${symbol}:direction:${direction}:r${range}:dd${drawdownRatio}:lp${lastPartRatio}:f${factorMultiplier}`

            candidates.push({
              setKey,
              indication,
              config: { range, drawdownRatio, lastPartRatio, factorMultiplier },
            })
          }
        }
      }
    }

    const pendingWrites = await this.attachQualifiedCandidates(symbol, marketData, candidates)
    qualified = pendingWrites.length

    // Batch write all qualified indications
    if (pendingWrites.length > 0) {
      await this.batchSaveIndications(pendingWrites, "direction")
    }

    return { type: "direction", total, qualified, configs: pendingWrites.length }
  }

  /**
   * Process Move Indication Set (ranges 2-30, no opposite requirement)
   * OPTIMIZED: Process key ranges only, batch writes
   */
  private async processMoveSet(symbol: string, marketData: any): Promise<any> {
    const keyRanges = this.directionMoveRanges
    const drawdownRatios = this.drawdownRatios
    const lastPartRatios = this.lastPartRatios
    const factorMultipliers = this.factorMultipliers
    let qualified = 0
    let total = 0
    const candidates: IndicationCandidate[] = []

    for (const range of keyRanges) {
      for (const drawdownRatio of drawdownRatios) {
        for (const lastPartRatio of lastPartRatios) {
          for (const factorMultiplier of factorMultipliers) {
            const indication = this.calculateMoveIndication(marketData, {
              range,
              drawdownRatio,
              lastPartRatio,
              factorMultiplier,
            })
            if (!indication) continue
            
            total++
            // movement > 0 = price went up = long signal; movement < 0 = short.
            // Direction is embedded in the key so long/short are independent sets.
            const direction = (indication.metadata?.movement || 0) >= 0 ? "long" : "short"
            indication.direction = direction
            const setKey = `indication_set:${this.connectionId}:${symbol}:move:${direction}:r${range}:dd${drawdownRatio}:lp${lastPartRatio}:f${factorMultiplier}`

            candidates.push({
              setKey,
              indication,
              config: { range, drawdownRatio, lastPartRatio, factorMultiplier },
            })
          }
        }
      }
    }

    const pendingWrites = await this.attachQualifiedCandidates(symbol, marketData, candidates)
    qualified = pendingWrites.length

    if (pendingWrites.length > 0) {
      await this.batchSaveIndications(pendingWrites, "move")
    }

    return { type: "move", total, qualified, configs: pendingWrites.length }
  }

  /**
   * Process Active Indication Set (thresholds 0.5-2.5%)
   */
  private async processActiveSet(symbol: string, marketData: any): Promise<any> {
    const thresholds = this.activeThresholds
    const drawdownRatios = this.drawdownRatios
    const activeTimeRatios = this.activeTimeRatios
    const lastPartRatios = this.lastPartRatios
    const factorMultipliers = this.factorMultipliers
    let qualified = 0
    let total = 0
    const candidates: IndicationCandidate[] = []

    for (const threshold of thresholds) {
      for (const drawdownRatio of drawdownRatios) {
        for (const activeTimeRatio of activeTimeRatios) {
          for (const lastPartRatio of lastPartRatios) {
            for (const factorMultiplier of factorMultipliers) {
              try {
                const indication = this.calculateActiveIndication(marketData, {
                  threshold,
                  drawdownRatio,
                  activeTimeRatio,
                  lastPartRatio,
                  factorMultiplier,
                })
                if (indication) {
                  total++
                  const setKey = `indication_set:${this.connectionId}:${symbol}:active:t${threshold}:dd${drawdownRatio}:ar${activeTimeRatio}:lp${lastPartRatio}:f${factorMultiplier}`
                  candidates.push({
                    setKey,
                    indication,
                    config: { threshold, drawdownRatio, activeTimeRatio, lastPartRatio, factorMultiplier },
                  })
                }
              } catch (error) {
                console.error(`[v0] [IndicationSets] Active config error:`, error)
              }
            }
          }
        }
      }
    }

    const pendingWrites = await this.attachQualifiedCandidates(symbol, marketData, candidates)
    qualified = pendingWrites.length

    if (pendingWrites.length > 0) {
      await this.batchSaveIndications(pendingWrites, "active")
    }

    return { type: "active", total, qualified, configs: pendingWrites.length }
  }

  /**
   * Process Active Advanced Indication Set.
   *
   * This is intentionally independent from the normal Active Set. It looks for
   * a minimum number of same-direction recent moves and a configurable
   * continuation ratio, then persists its own `active_advanced` set keys and
   * contributes separately to active/windowed stats.
   */
  private async processActiveAdvancedSet(symbol: string, marketData: any): Promise<any> {
    const activityRatios = this.activeAdvancedActivityRatios
    const minPositions = this.activeAdvancedMinPositions
    const continuationRatio = this.activeAdvancedContinuationRatio
    const factorMultipliers = this.factorMultipliers
    let qualified = 0
    let total = 0
    const candidates: IndicationCandidate[] = []

    for (const activityRatio of activityRatios) {
      for (const factorMultiplier of factorMultipliers) {
        const config = { activityRatio, minPositions, continuationRatio, factorMultiplier }
        const indication = this.calculateActiveAdvancedIndication(marketData, config)
        if (!indication) continue

        total++
        const direction = indication.metadata?.direction === "short" ? "short" : "long"
        indication.direction = direction
        const setKey = `indication_set:${this.connectionId}:${symbol}:active_advanced:ar${activityRatio}:min${minPositions}:cr${continuationRatio}:f${factorMultiplier}`

        candidates.push({ setKey, indication, config })
      }
    }

    const pendingWrites = await this.attachQualifiedCandidates(symbol, marketData, candidates)
    qualified = pendingWrites.length

    if (pendingWrites.length > 0) {
      await this.batchSaveIndications(pendingWrites, "active_advanced")
    }

    return { type: "active_advanced", total, qualified, configs: pendingWrites.length }
  }

  /**
   * Process Optimal Indication Set (consecutive step detection)
   * OPTIMIZED: Process key ranges only, batch writes
   */
  private async processOptimalSet(symbol: string, marketData: any): Promise<any> {
    const keyRanges = this.optimalRanges
    const factorMultipliers = this.factorMultipliers
    let qualified = 0
    let total = 0
    const candidates: IndicationCandidate[] = []

    for (const range of keyRanges) {
      for (const factorMultiplier of factorMultipliers) {
        const indication = this.calculateOptimalIndication(marketData, range, factorMultiplier)
        if (!indication) continue
        
        total++
        const setKey = `indication_set:${this.connectionId}:${symbol}:optimal:range${range}:factor${factorMultiplier}`
        candidates.push({ setKey, indication, config: { range, factorMultiplier } })
      }
    }

    const pendingWrites = await this.attachQualifiedCandidates(symbol, marketData, candidates)
    qualified = pendingWrites.length

    if (pendingWrites.length > 0) {
      await this.batchSaveIndications(pendingWrites, "optimal")
    }

    return { type: "optimal", total, qualified, configs: pendingWrites.length }
  }

  /**
   * Batch save multiple indications - much more efficient than individual saves.
   *
   * Each entry persists the full set of fields downstream consumers need:
   *   - `type`        : indication type (direction|move|active|optimal|active_advanced)
   *   - `direction`   : long|short — required for per-direction position-cap
   *                     enforcement when the entry is replayed by the strategy
   *                     pipeline. Pulled from `indication.direction` (set
   *                     upstream in `processDirectionSet`/`processMoveSet`)
   *                     with sane fallbacks: explicit metadata.firstDir,
   *                     then "long" as last resort.
   *   - `setKey`      : not stored on the entry (it lives on the Redis key
   *                     itself) — but `getSetEntries` re-attaches it for
   *                     consumers that need provenance.
   *
   * The 250-cap (configurable via `getLimit`) is applied PER setKey — i.e.
   * per independent Set. This is the documented per-DB-entry cap; cycle
   * counters / frame counters are completely independent of it.
   */
  private async batchSaveIndications(
    writes: Array<{ setKey: string; indication: any; config: any }>,
    type: string
  ): Promise<void> {
    if (writes.length === 0) return

    try {
      const client = await getCachedClient()

      const now = Date.now()
      const timestamp = new Date().toISOString()

      // Resolve compaction config once for the whole batch — type is
      // fixed for all writes in this call (the public batchSave API
      // takes a single `type`), so a single async resolution covers
      // every chunk and keeps the inner loop synchronous w.r.t. config
      // lookup.
      const compactionCfg = await this.resolveCompaction(type as keyof IndicationSetLimits)
      const grouped = new Map<string, string[]>()
      writes.forEach(({ setKey, indication, config }, idx) => {
        // Resolve direction with progressive fallbacks. The strategy
        // coordinator + live-stage both use this field, so it MUST
        // be on the persisted entry to avoid silent "long" fallback.
        const direction: "long" | "short" =
          indication.direction === "short"
            ? "short"
            : indication.direction === "long"
            ? "long"
            : indication?.metadata?.firstDir < 0
            ? "short"
            : "long"

        const entry = {
          id: `${type}_${now}_${idx}_${Math.random().toString(36).slice(2, 6)}`,
          timestamp,
          type,
          direction,
          profitFactor: indication.profitFactor,
          signalScore: indication.signalScore,
          rawSignalStrength: indication.rawSignalStrength,
          confidence: indication.confidence,
          config,
          metadata: indication.metadata,
        }

        const bucket = grouped.get(setKey)
        if (bucket) bucket.push(JSON.stringify(entry))
        else grouped.set(setKey, [JSON.stringify(entry)])
      })

      // Append each grouped set through the shared helper so legacy JSON-array
      // keys are migrated to Redis LISTs consistently with the single-save path.
      const groupedEntries = Array.from(grouped.entries())
      for (const [setKey, serializedEntries] of groupedEntries) {
        await this.appendIndicationEntries(client, setKey, serializedEntries, compactionCfg)
        await this.indexSetKey(client, setKey, setKey.split(':')[2], type)
      }
    } catch (error) {
      // Silent fail for non-critical batch operations
    }
  }

  /**
   * Save indication to its independent set pool (per-Set cap, default 250
   * entries — see `DEFAULT_LIMITS` for per-type values).
   *
   * Persists the same shape as `batchSaveIndications` so consumers can
   * read either path interchangeably.
   *
   * NOTE: The legacy `Math.random() > 0.5` direction fallback used in the
   * realtime broadcast was non-deterministic — it produced UP/DOWN flicker
   * on the dashboard for every cell every cycle. The fix derives the
   * direction from the actual indication payload and falls back to NEUTRAL
   * for non-directional types (active/optimal/active_advanced).
   */
  private async saveIndicationToSet(
    setKey: string,
    indication: any,
    type: string,
    config: any
  ): Promise<void> {
    try {
      const client = await getCachedClient()

      // Same direction-resolution logic as batchSaveIndications — see comment there.
      const direction: "long" | "short" =
        indication.direction === "short"
          ? "short"
          : indication.direction === "long"
          ? "long"
          : indication?.metadata?.firstDir < 0
          ? "short"
          : "long"

      const id = `${type}_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`
      // Newest-at-last per spec. Redis RPUSH appends at the tail, matching
      // the previous chronological JSON-array invariant without a
      // GET/parse/append/SET round-trip.
      const entry = {
        id,
        timestamp: new Date().toISOString(),
        type,
        direction,
        profitFactor: indication.profitFactor,
        signalScore: indication.signalScore,
        rawSignalStrength: indication.rawSignalStrength,
        confidence: indication.confidence,
        config,
        metadata: indication.metadata,
      }

      // Debounced threshold compaction. The cfg lookup is cached on
      // the processor instance with a 5s TTL so this single-save path
      // pays at most one Redis round-trip every 5s for config — every
      // subsequent call is a synchronous map lookup + a comparison.
      const cfg = await this.resolveCompaction(type as keyof IndicationSetLimits)
      await this.appendIndicationEntries(client, setKey, [JSON.stringify(entry)], cfg)

      // Broadcast indication update to connected clients. Direction is
      // derived from the actual indication signal — directional types
      // (direction/move) report UP/DOWN, all other types (active /
      // optimal / active_advanced) report NEUTRAL.
      const symbol = setKey.split(':')[2]
      await this.indexSetKey(client, setKey, symbol, type)

      const broadcastDirection: "UP" | "DOWN" | "NEUTRAL" =
        type === "direction" || type === "move"
          ? direction === "long"
            ? "UP"
            : "DOWN"
          : "NEUTRAL"
      emitIndicationUpdate(this.connectionId, {
        id,
        symbol,
        direction: broadcastDirection,
        confidence: indication.confidence || 0,
        strength: indication.profitFactor || 0,
      })
      
      // Stats updates removed - too expensive for high-frequency operations
    } catch (error) {
      // Silent fail
    }
  }

  /**
   * Calculation methods for each type
   */

  private async attachOutcomeBackedProfitFactor(
    symbol: string,
    marketData: any,
    setKey: string,
    indication: any,
  ): Promise<number> {
    const outcome = this.evaluateForwardOutcome(marketData, indication.direction)
    if (outcome.completed) {
      const sample = {
        profit: Math.max(outcome.pnlPct, 0),
        loss: Math.max(-outcome.pnlPct, 0),
        pnlPct: outcome.pnlPct,
        closedAt: new Date().toISOString(),
      }
      const pf = await this.recordOutcomeSample(setKey, sample)
      indication.profitFactor = pf
      indication.metadata = {
        ...indication.metadata,
        outcome,
        profitFactorSource: "realized_forward_outcomes",
      }
      return pf
    }

    indication.profitFactor = 0
    indication.metadata = {
      ...indication.metadata,
      outcomePending: true,
      profitFactorSource: "pending_realtime_outcome",
    }
    await this.persistPendingRealtimeOutcome(symbol, setKey, indication)
    return indication.signalScore || indication.rawSignalStrength || 0
  }

  /**
   * Record a realized outcome sample and return the current profit factor.
   *
   * Outcome samples stay in the capped Redis LIST for audit/debug consumers,
   * while `${setKey}:outcome_stats` maintains the rolling aggregate used for
   * profit-factor reads. This avoids an LRANGE + full-window recomputation on
   * every sample. If the aggregate hash is missing or malformed, rebuild it
   * once from the capped list and continue from the repaired values.
   */
  private async recordOutcomeSample(setKey: string, sample: any): Promise<number> {
    const client = await getCachedClient()
    const key = `${setKey}:outcomes`
    const statsKey = `${setKey}:outcome_stats`
    const cap = 1000
    const serializedSample = JSON.stringify(sample)
    const sampleProfit = this.toOutcomeAmount(sample?.profit)
    const sampleLoss = this.toOutcomeAmount(sample?.loss)

    const evalLua = (client as any)?.eval as
      | ((script: string, options: { keys: string[]; arguments: string[] }) => Promise<any>)
      | undefined
    if (typeof evalLua === "function") {
      const result = await evalLua.call(client, RECORD_OUTCOME_SAMPLE_SCRIPT, {
        keys: [key, statsKey],
        arguments: [serializedSample, String(sampleProfit), String(sampleLoss), String(cap)],
      })
      const grossProfit = Number(result?.[0] ?? 0)
      const grossLoss = Number(result?.[1] ?? 0)
      return this.profitFactorFromOutcomeStats(grossProfit, grossLoss)
    }

    return this.recordOutcomeSampleWithWatch(client, key, statsKey, serializedSample, sampleProfit, sampleLoss, cap)
  }

  private async recordOutcomeSampleWithWatch(
    client: any,
    key: string,
    statsKey: string,
    serializedSample: string,
    sampleProfit: number,
    sampleLoss: number,
    cap: number,
  ): Promise<number> {
    const canWatch = typeof client?.watch === "function" && typeof client?.unwatch === "function"
    const maxAttempts = canWatch ? 8 : 1

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      if (canWatch) await client.watch(key, statsKey)
      try {
        const rawStats = await client.hgetall(statsKey)
        const existingStats = this.parseOutcomeStats(rawStats)

        const currentLength = Number(await client.llen(key)) || 0
        const evictCount = Math.max(0, currentLength + 1 - cap)

        if (!existingStats) {
          const tx = client.multi()
          tx.rpush(key, serializedSample)
          if (evictCount > 0) tx.ltrim(key, -cap, -1)
          const execResult = await tx.exec()
          if (!canWatch || execResult !== null) {
            return this.repairOutcomeStatsFromSamples(client, key, statsKey)
          }
          continue
        }
        let evictedProfit = 0
        let evictedLoss = 0
        let evictedCount = 0
        if (evictCount > 0) {
          const evictedRaw: string[] = await client.lrange(key, 0, evictCount - 1)
          for (const item of evictedRaw) {
            const parsed = this.parseOutcomeSample(item)
            if (!parsed) continue
            evictedProfit += parsed.profit
            evictedLoss += parsed.loss
            evictedCount++
          }
        }

        const grossProfit = Math.max(0, existingStats.grossProfit + sampleProfit - evictedProfit)
        const grossLoss = Math.max(0, existingStats.grossLoss + sampleLoss - evictedLoss)
        const count = Math.max(0, existingStats.count + 1 - evictedCount)

        const tx = client.multi()
        tx.rpush(key, serializedSample)
        if (evictCount > 0) tx.ltrim(key, -cap, -1)
        tx.hset(statsKey, {
          grossProfit: String(grossProfit),
          grossLoss: String(grossLoss),
          count: String(count),
        })
        const execResult = await tx.exec()
        if (!canWatch || execResult !== null) {
          return this.profitFactorFromOutcomeStats(grossProfit, grossLoss)
        }
      } finally {
        if (canWatch) await client.unwatch().catch(() => {})
      }
    }

    throw new Error(`[IndicationSets] Failed to atomically record outcome sample for ${key} after retries`)
  }

  private toOutcomeAmount(value: any): number {
    const amount = Number(value || 0)
    return Number.isFinite(amount) && amount > 0 ? amount : 0
  }

  private parseOutcomeSample(raw: string): { profit: number; loss: number } | null {
    try {
      const sample = JSON.parse(raw)
      return {
        profit: this.toOutcomeAmount(sample?.profit),
        loss: this.toOutcomeAmount(sample?.loss),
      }
    } catch {
      return null
    }
  }

  private parseOutcomeStats(
    stats: Record<string, string> | null | undefined,
  ): { grossProfit: number; grossLoss: number; count: number } | null {
    if (
      !stats ||
      !Object.prototype.hasOwnProperty.call(stats, "grossProfit") ||
      !Object.prototype.hasOwnProperty.call(stats, "grossLoss") ||
      !Object.prototype.hasOwnProperty.call(stats, "count")
    ) {
      return null
    }
    const grossProfit = Number(stats.grossProfit)
    const grossLoss = Number(stats.grossLoss)
    const count = Number(stats.count)
    if (
      !Number.isFinite(grossProfit) ||
      !Number.isFinite(grossLoss) ||
      !Number.isFinite(count) ||
      grossProfit < 0 ||
      grossLoss < 0 ||
      count < 0
    ) {
      return null
    }
    return { grossProfit, grossLoss, count }
  }

  private async repairOutcomeStatsFromSamples(client: any, key: string, statsKey: string): Promise<number> {
    const raw: string[] = await client.lrange(key, 0, -1)
    let grossProfit = 0
    let grossLoss = 0
    let count = 0
    for (const item of raw) {
      const parsed = this.parseOutcomeSample(item)
      if (!parsed) continue
      grossProfit += parsed.profit
      grossLoss += parsed.loss
      count++
    }
    await client.hset(statsKey, {
      grossProfit: String(grossProfit),
      grossLoss: String(grossLoss),
      count: String(count),
    })
    return this.profitFactorFromOutcomeStats(grossProfit, grossLoss)
  }

  private profitFactorFromOutcomeStats(grossProfit: number, grossLoss: number): number {
    if (grossLoss <= 0) return grossProfit > 0 ? grossProfit / 0.000001 : 0
    return grossProfit / grossLoss
  }

  private async persistPendingRealtimeOutcome(symbol: string, setKey: string, indication: any): Promise<void> {
    try {
      const client = await getCachedClient()
      const key = `indication_outcomes_pending:${this.connectionId}:${symbol}`
      const pending = {
        setKey,
        direction: indication.direction,
        signalScore: indication.signalScore,
        rawSignalStrength: indication.rawSignalStrength,
        openedAt: Date.now(),
      }
      await client.rpush(key, JSON.stringify(pending))
      // Per-symbol pending-outcome list cap. In dev this was the single biggest
      // in-memory Redis family (~150 KB/symbol × symbols = multiple MB restored
      // into the InlineLocalRedis Map every boot). 1000 pending signals/symbol is
      // far more than the low-RAM dev VM needs; 100 is plenty to evaluate forward
      // outcomes. Production keeps the full 1000-entry window.
      // Scale with symbol count: 30 per symbol in dev (e.g. 300 for 10 symbols).
      const pendingCap = 1000
      await client.ltrim(key, -pendingCap, -1)
      await client.expire(key, 86400)
    } catch { /* non-critical */ }
  }

  private async closePendingRealtimeOutcomes(symbol: string, marketData: any): Promise<void> {
    if (!marketData) return
    try {
      if (this.getForwardCandles(marketData).length < 2) return
      const client = await getCachedClient()
      const key = `indication_outcomes_pending:${this.connectionId}:${symbol}`
      const raw: string[] = await client.lrange(key, 0, -1)
      if (!raw?.length) return
      await client.del(key)

      // Separate still-pending from newly-closed in a single synchronous pass
      // (evaluateForwardOutcome is pure-sync — no I/O).
      const stillPending: string[] = []
      const closedItems: Array<{ item: string; pending: any; closed: any }> = []
      for (const item of raw) {
        let pending: any
        try { pending = JSON.parse(item) } catch { continue }
        const closed = this.evaluateForwardOutcome(marketData, pending.direction)
        if (!closed.completed) {
          stillPending.push(item)
        } else {
          closedItems.push({ item, pending, closed })
        }
      }

      // Re-queue still-pending items in one rpush call (was one per item).
      if (stillPending.length > 0) {
        await client.rpush(key, ...stillPending)
      }

      // Process closed items — fan out get+record+set per unique setKey.
      // Group by setKey first so we do at most one get/set per key even if
      // multiple pending items share the same set.
      const bySetKey = new Map<string, Array<{ pending: any; closed: any }>>()
      for (const { pending, closed } of closedItems) {
        const arr = bySetKey.get(pending.setKey) ?? []
        arr.push({ pending, closed })
        bySetKey.set(pending.setKey, arr)
      }

      await Promise.all(
        [...bySetKey.entries()].map(async ([setKey, items]) => {
          // Record all outcome samples for this setKey before reading entries,
          // so the final PF reflects all closed outcomes from this cycle.
          let pf = 0
          for (const { closed } of items) {
            pf = await this.recordOutcomeSample(setKey, {
              profit:   Math.max(closed.pnlPct, 0),
              loss:     Math.max(-closed.pnlPct, 0),
              pnlPct:   closed.pnlPct,
              closedAt: new Date().toISOString(),
            })
          }
          // Single read-modify-write per setKey regardless of how many
          // pending items referenced it. Read through the shared helper so
          // LIST-backed sets stay in the modern representation and legacy
          // JSON-array strings are still readable during migration.
          const entries = await this.readIndicationSetEntries(client, setKey)
          let patchCount = items.length
          let patched = false
          for (let i = entries.length - 1; i >= 0 && patchCount > 0; i--) {
            if (entries[i]?.profitFactor === 0 && entries[i]?.metadata?.outcomePending) {
              const closed = items[items.length - patchCount].closed
              entries[i].profitFactor = pf
              entries[i].metadata = { ...entries[i].metadata, outcomePending: false, outcome: closed }
              patchCount--
              patched = true
            }
          }
          if (!patched) return

          // Preserve LIST-backed indication_set:* keys when closing pending
          // realtime outcomes. DEL + RPUSH recreates the key as a Redis LIST
          // instead of SET-ing a legacy JSON string, then applies the same
          // compaction and index policy used by appendIndicationEntries().
          const type = (setKey.split(":")[3] || "direction") as keyof IndicationSetLimits
          const cfg = await this.resolveCompaction(type)
          const serializedEntries = entries.map((entry) => JSON.stringify(entry))
          await client.del(setKey)
          const length = serializedEntries.length > 0 ? await client.rpush(setKey, ...serializedEntries) : 0
          if (length >= compactionCeiling(cfg)) {
            await client.ltrim(setKey, -cfg.floor, -1)
          }
          await this.indexSetKey(client, setKey, setKey.split(":")[2], type)
        }),
      )

      await client.expire(key, 86400)
    } catch { /* non-critical */ }
  }

  private evaluateForwardOutcome(marketData: any, direction: "long" | "short"): any {
    const candles = this.getForwardCandles(marketData)
    if (candles.length < 2) return { completed: false, reason: "insufficient_forward_candles" }
    const entry = Number(marketData.executionPrice ?? candles[1].open ?? candles[1].close ?? candles[1].price)
    if (!Number.isFinite(entry) || entry <= 0) return { completed: false, reason: "invalid_entry_price" }
    const cost = this.outcomeTakerFeePct * 2 + this.outcomeSlippagePct
    const tp = direction === "long" ? entry * (1 + this.outcomeTakeProfitPct) : entry * (1 - this.outcomeTakeProfitPct)
    const sl = direction === "long" ? entry * (1 - this.outcomeStopLossPct) : entry * (1 + this.outcomeStopLossPct)
    const horizon = Math.min(candles.length - 1, Math.max(1, Math.floor(this.outcomeHorizonCandles)))
    let exit = Number(candles[horizon].close ?? candles[horizon].price ?? candles[horizon].open)
    let reason = "horizon"
    for (let i = 1; i <= horizon; i++) {
      const high = Number(candles[i].high ?? candles[i].close ?? candles[i].price ?? candles[i].open)
      const low = Number(candles[i].low ?? candles[i].close ?? candles[i].price ?? candles[i].open)
      if (direction === "long" && high >= tp) { exit = tp; reason = "take_profit"; break }
      if (direction === "long" && low <= sl) { exit = sl; reason = "stop_loss"; break }
      if (direction === "short" && low <= tp) { exit = tp; reason = "take_profit"; break }
      if (direction === "short" && high >= sl) { exit = sl; reason = "stop_loss"; break }
    }
    const gross = direction === "long" ? (exit - entry) / entry : (entry - exit) / entry
    return { completed: true, entry, exit, reason, pnlPct: gross - cost, costPct: cost, horizonCandles: horizon }
  }

  private getForwardCandles(marketData: any): any[] {
    const raw = Array.isArray(marketData?.forwardCandles)
      ? marketData.forwardCandles
      : Array.isArray(marketData?.candles)
      ? marketData.candles
      : []
    const candles = raw
      .map((c: any) => (typeof c === "number" ? { open: c, high: c, low: c, close: c } : c))
      .filter((c: any) => Number.isFinite(Number(c?.close ?? c?.price ?? c?.open)))
    if (candles.length < 2) return candles
    const firstTs = Number(candles[0]?.timestamp ?? candles[0]?.time ?? 0)
    const lastTs = Number(candles[candles.length - 1]?.timestamp ?? candles[candles.length - 1]?.time ?? 0)
    return firstTs > lastTs ? candles.slice().reverse() : candles
  }

  private calculateDirectionIndication(
    marketData: any,
    config: { range: number; drawdownRatio: number; lastPartRatio: number; factorMultiplier: number },
  ): any {
    const { range, drawdownRatio, lastPartRatio, factorMultiplier } = config
    const prices = this.getPriceHistory(marketData, range * 2)
    if (!prices || prices.length < range * 2) return null

    const firstHalf = prices.slice(0, range)
    const secondHalf = prices.slice(range)

    const firstDir = this.getDirection(firstHalf)
    const secondDir = this.getDirection(secondHalf)

    // Opposite direction = signal
    if ((firstDir > 0 && secondDir < 0) || (firstDir < 0 && secondDir > 0)) {
      const reversalStrength = Math.abs(firstDir + secondDir)
      const drawdownPenalty = reversalStrength / Math.max(drawdownRatio * 10, 1)
      const tailWeight = 1 + lastPartRatio
      const signalScore = 1.0 + reversalStrength * factorMultiplier * tailWeight - drawdownPenalty
      return {
        profitFactor: 0,
        signalScore,
        rawSignalStrength: signalScore,
        confidence: Math.min(1.0, ((Math.abs(firstDir) + Math.abs(secondDir)) / 2) * factorMultiplier),
        metadata: { firstDir, secondDir, range, drawdownRatio, lastPartRatio, factorMultiplier },
      }
    }

    return null
  }

  private calculateMoveIndication(
    marketData: any,
    config: { range: number; drawdownRatio: number; lastPartRatio: number; factorMultiplier: number },
  ): any {
    const { range, drawdownRatio, lastPartRatio, factorMultiplier } = config
    const prices = this.getPriceHistory(marketData, range)
    if (!prices || prices.length < range) return null

    const oldestPrice = prices[0]
    const newestPrice = prices[range - 1]
    const movement = Math.abs(newestPrice - oldestPrice) / oldestPrice
    const volatility = this.calculateVolatility(prices)
    const drawdownPenalty = movement / Math.max(drawdownRatio * 10, 1)
    const tailWeight = 1 + lastPartRatio

    const signalScore = 1.0 + (movement * 2 + volatility) * factorMultiplier * tailWeight - drawdownPenalty
    return {
      profitFactor: 0,
      signalScore,
      rawSignalStrength: signalScore,
      confidence: Math.min(1.0, (movement + volatility / 2) * factorMultiplier),
      metadata: { movement, volatility, range, drawdownRatio, lastPartRatio, factorMultiplier },
    }
  }

  private calculateActiveIndication(
    marketData: any,
    config: {
      threshold: number
      drawdownRatio: number
      activeTimeRatio: number
      lastPartRatio: number
      factorMultiplier: number
    },
  ): any {
    const { threshold, drawdownRatio, activeTimeRatio, lastPartRatio, factorMultiplier } = config
    const prices = this.getPriceHistory(marketData, 10)
    if (!prices || prices.length < 2) return null

    const oldestPrice = prices[0]
    const newestPrice = prices[prices.length - 1]
    const priceChange = Math.abs((newestPrice - oldestPrice) / oldestPrice) * 100

    if (priceChange >= threshold) {
      const normalizedChange = priceChange / Math.max(threshold, 0.1)
      const estimatedDrawdown = Math.max(0.1, normalizedChange / Math.max(drawdownRatio, 0.1))
      const activeTimeScore = normalizedChange * activeTimeRatio
      const tailWeight = 1 + lastPartRatio
      const signalScore = 1.0 + ((priceChange / 100) * factorMultiplier * tailWeight) - (estimatedDrawdown * 0.01)
      return {
        profitFactor: 0,
        signalScore,
        rawSignalStrength: signalScore,
        confidence: Math.min(1.0, priceChange / threshold / 2),
        metadata: {
          priceChange,
          threshold,
          drawdownRatio,
          activeTimeRatio,
          lastPartRatio,
          factorMultiplier,
          estimatedDrawdown,
          activeTimeScore,
        },
      }
    }

    return null
  }

  private calculateActiveAdvancedIndication(
    marketData: any,
    config: {
      activityRatio: number
      minPositions: number
      continuationRatio: number
      factorMultiplier: number
    },
  ): any {
    const { activityRatio, minPositions, continuationRatio, factorMultiplier } = config
    const window = Math.max(minPositions + 2, 8)
    const prices = this.getPriceHistory(marketData, window)
    if (!prices || prices.length < minPositions + 1) return null

    const moves: number[] = []
    for (let i = 1; i < prices.length; i++) {
      const prev = prices[i - 1]
      const curr = prices[i]
      if (!Number.isFinite(prev) || !Number.isFinite(curr) || prev <= 0) continue
      moves.push((curr - prev) / prev)
    }
    if (moves.length < minPositions) return null

    const longMoves = moves.filter((m) => m > 0)
    const shortMoves = moves.filter((m) => m < 0)
    const direction = longMoves.length >= shortMoves.length ? "long" : "short"
    const alignedMoves = direction === "long" ? longMoves : shortMoves
    if (alignedMoves.length < minPositions) return null

    const continuity = alignedMoves.length / moves.length
    if (continuity < continuationRatio) return null

    const avgMagnitudePct =
      (alignedMoves.reduce((sum, m) => sum + Math.abs(m), 0) / Math.max(1, alignedMoves.length)) * 100
    if (avgMagnitudePct < activityRatio) return null

    const volatility = this.calculateVolatility(prices)
    const signalScore = 1.0 + ((avgMagnitudePct / Math.max(activityRatio, 0.1)) * continuity + volatility) * factorMultiplier

    return {
      profitFactor: 0,
      signalScore,
      rawSignalStrength: signalScore,
      confidence: Math.min(1.0, 0.45 + continuity * 0.35 + Math.min(0.2, avgMagnitudePct / 20)),
      metadata: {
        direction,
        activityRatio,
        minPositions,
        continuationRatio,
        factorMultiplier,
        continuity,
        avgMagnitudePct,
        volatility,
      },
    }
  }

  private calculateOptimalIndication(marketData: any, range: number, factorMultiplier: number): any {
    const prices = this.getPriceHistory(marketData, range * 3)
    if (!prices || prices.length < range * 3) return null

    // Consecutive steps: multiple direction changes = optimal signal
    const steps = this.detectConsecutiveSteps(prices, range)

    if (steps >= 2) {
      const volatility = this.calculateVolatility(prices)
      const signalScore = 1.0 + (steps * 0.5 + volatility) * factorMultiplier
      return {
        profitFactor: 0,
        signalScore,
        rawSignalStrength: signalScore,
        confidence: Math.min(1.0, steps / 3),
        metadata: { consecutiveSteps: steps, volatility, range, factorMultiplier },
      }
    }

    return null
  }

  /**
   * Helper methods
   */

  private getPriceHistory(marketData: any, count: number): number[] | null {
    const normalizedOldestFirst = this.normalizePriceHistory(marketData)
    if (normalizedOldestFirst.length === 0) return null

    // All calculators receive oldest-first windows: prices[0] is oldest and
    // prices[prices.length - 1] is newest/current.
    return normalizedOldestFirst.slice(-count)
  }

  private normalizePriceHistory(marketData: any): number[] {
    if (Array.isArray(marketData?.__normalizedPricesOldestFirst)) {
      return marketData.__normalizedPricesOldestFirst
    }

    const rawPrices = Array.isArray(marketData?.prices)
      ? marketData.prices
      : Array.isArray(marketData?.candles)
        ? [...marketData.candles]
            .sort((a: any, b: any) => Number(a?.timestamp ?? 0) - Number(b?.timestamp ?? 0))
            .map((c: any) => c?.close ?? c?.price ?? c?.last ?? c?.markPrice)
        : []

    const parsedPrices = rawPrices
      .map((p: any) => Number.parseFloat(String(p)))
      .filter((p: number) => Number.isFinite(p))

    const order = marketData?.priceOrder || marketData?.pricesOrder || marketData?.order
    const oldestFirst = order === "oldest-first" || order === "oldestFirst" || order === "asc"
    const normalizedOldestFirst = oldestFirst ? parsedPrices : [...parsedPrices].reverse()
    if (marketData && typeof marketData === "object") {
      marketData.__normalizedPricesOldestFirst = normalizedOldestFirst
      marketData.priceOrder = "oldest-first"
    }
    return normalizedOldestFirst
  }

  private getAvailablePriceCount(marketData: any): number {
    if (Array.isArray(marketData?.prices)) return marketData.prices.length
    if (Array.isArray(marketData?.candles)) return marketData.candles.length
    return 0
  }

  private getLargestConfiguredRange(): number {
    // Returns the maximum price history length required to generate strategies.
    // Reduced multipliers for faster strategy generation in testing:
    // OLD: range * 2 and range * 3 = 135 max (needs 135 hours = 5.6 days)
    // NEW: range * 1 and range * 1.5 = 45 max (needs 45 hours = 1.9 days)
    // NEWER: range * 1 and range * 1 = 30 max (needs 30 hours = 1.25 days - for testing)
    //
    // This drastically reduces warm-up period while maintaining core logic.
    return Math.max(
      10,
      ...this.directionMoveRanges.map((range) => range * 1),
      ...this.optimalRanges.map((range) => range * 1),
    )
  }

  private async warnIfPriceHistoryTooShort(symbol: string, marketData: any, normalizedPriceCount?: number): Promise<boolean> {
    const availablePrices = normalizedPriceCount ?? this.normalizePriceHistory(marketData).length
    const requiredPrices = this.getLargestConfiguredRange()
    if (availablePrices >= requiredPrices) return true

    const warningKey = `${symbol}:${availablePrices}:${requiredPrices}`
    if (this.shortPriceHistoryWarnings.has(warningKey)) return false
    this.shortPriceHistoryWarnings.add(warningKey)

    console.warn(
      `[v0] [IndicationSets] ${symbol}: only ${availablePrices} price(s) available; largest configured range requires ${requiredPrices}. Some sets may not be produced.`,
    )
    await logProgressionEvent(this.connectionId, "indications_sets", "warning", `Insufficient price history for ${symbol}`, {
      symbol,
      availablePrices,
      requiredPrices,
      reason: "insufficient_price_history",
    }).catch(() => {})
    return false
  }

  private getDirection(prices: number[]): number {
    if (prices.length === 0) return 0
    const avg = prices.reduce((a, b) => a + b, 0) / prices.length
    if (!Number.isFinite(avg)) return 0
    return prices.reduce((a, b) => a + (b > avg ? 1 : -1), 0) / prices.length
  }

  private calculateVolatility(prices: number[]): number {
    if (prices.length < 2) return 0
    const avg = prices.reduce((a, b) => a + b, 0) / prices.length
    if (!Number.isFinite(avg) || avg === 0) return 0
    const variance = prices.reduce((a, b) => a + Math.pow(b - avg, 2), 0) / prices.length
    const vol = Math.sqrt(variance) / avg
    return Number.isFinite(vol) ? vol : 0
  }

  private detectConsecutiveSteps(prices: number[], range: number): number {
    if (prices.length < range * 2) return 0
    let steps = 0
    for (let i = range; i < prices.length - range; i += range) {
      const slice1 = prices.slice(i - range, i)
      const slice2 = prices.slice(i, i + range)
      if (slice1.length === 0 || slice2.length === 0) continue
      const dir1 = this.getDirection(slice1)
      const dir2 = this.getDirection(slice2)
      if ((dir1 > 0 && dir2 < 0) || (dir1 < 0 && dir2 > 0)) {
        steps++
      }
    }
    return steps
  }

  /**
   * Get stats for a specific indication type set
   */
  async getSetStats(symbol: string, type: string): Promise<any> {
    try {
      const client = await getCachedClient()
      if (!client) {
        return {
          type,
          totalConfigurations: 0,
          currentEntries: 0,
          avgProfitFactor: 0,
          avgConfidence: 0,
          error: "Redis client not available",
        }
      }
      const keys = await this.getIndexedSetKeys(client, symbol, type)
      if (!keys || keys.length === 0) {
        return {
          type,
          totalConfigurations: 0,
          currentEntries: 0,
          avgProfitFactor: 0,
          avgConfidence: 0,
        }
      }

      // Fan out all reads in parallel. New keys are Redis LISTs; legacy keys
      // may still be JSON arrays, so the helper falls back to GET/JSON parse.
      const values = await Promise.all(keys.map((k: string) => this.readIndicationSetEntries(client, k)))

      let totalEntries = 0
      let totalProfitFactor = 0
      let totalConfidence = 0
      let sampleCount = 0

      for (const entries of values) {
        if (!Array.isArray(entries)) continue

        totalEntries += entries.length
        for (const entry of entries) {
          totalProfitFactor += Number(entry?.profitFactor || 0)
          totalConfidence   += Number(entry?.confidence   || 0)
          sampleCount++
        }
      }

      return {
        type,
        totalConfigurations: keys.length,
        currentEntries: totalEntries,
        avgProfitFactor: sampleCount > 0 ? totalProfitFactor / sampleCount : 0,
        avgConfidence: sampleCount > 0 ? totalConfidence / sampleCount : 0,
      }
    } catch (error) {
      console.error(`[v0] [IndicationSets] Failed to get stats for ${type}:`, error)
      return null
    }
  }

  /**
   * Get all entries from a specific indication type set
   */
  async getSetEntries(symbol: string, type: string, limit = 50): Promise<any[]> {
    try {
      const client = await getCachedClient()
      const keys = await this.getIndexedSetKeys(client, symbol, type)
      if (!keys || keys.length === 0) return []

      // Fan out all reads in parallel. New keys are Redis LISTs; legacy keys
      // may still be JSON arrays, so the helper falls back to GET/JSON parse.
      const values = await Promise.all(keys.map((k: string) => this.readIndicationSetEntries(client, k)))
      const allEntries: any[] = []
      for (let i = 0; i < values.length; i++) {
        const entries = values[i]
        if (!Array.isArray(entries)) continue
        allEntries.push(...entries.map((entry) => ({ ...entry, setKey: keys[i] })))
      }

      return allEntries
        .sort((a, b) => new Date(b.timestamp || 0).getTime() - new Date(a.timestamp || 0).getTime())
        .slice(0, limit)
    } catch (error) {
      console.error(`[v0] [IndicationSets] Failed to get entries for ${type}:`, error)
      return []
    }
  }
}
