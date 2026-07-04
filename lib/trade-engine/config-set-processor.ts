/**
 * Config Set Processor
 * Processes prehistoric data through indication and strategy config managers
 * Each configuration combination calculates independently and stores results
 * 
 * Phase 5-6 Implementation: Fills config sets with calculated results
 */

import { IndicationConfigManager, IndicationResult, IndicationConfig } from "@/lib/indication-config-manager"
import { StrategyConfigManager, PseudoPosition, StrategyConfig } from "@/lib/strategy-config-manager"
import { getRedisClient, initRedis, getSettings, setSettings } from "@/lib/redis-db"
import { logProgressionEvent } from "@/lib/engine-progression-logs"
import { ProgressionStateManager } from "@/lib/progression-state-manager"
import { canonicalTotalForSymbols, clampProcessedToTotal, getCanonicalSymbolSelection, ownsCanonicalSymbolSelectionEpoch } from "@/lib/trade-engine/symbol-selection-ownership"
import { calculatePseudoClosePnl } from "@/lib/pseudo-position-costs"

async function yieldToEventLoop(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve))
}

function groupConfigsByType<T extends { type?: string }>(configs: T[]): Array<[string, T[]]> {
  const grouped = new Map<string, T[]>()
  for (const config of configs) {
    const type = config.type || "unknown"
    const bucket = grouped.get(type)
    if (bucket) bucket.push(config)
    else grouped.set(type, [config])
  }
  return Array.from(grouped.entries())
}

async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  mapper: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  if (items.length === 0) return []

  const limit = Math.max(1, Math.min(concurrency, items.length))
  const results = new Array<R>(items.length)
  let nextIndex = 0

  const workers = Array.from({ length: limit }, async () => {
    while (nextIndex < items.length) {
      const index = nextIndex++
      results[index] = await mapper(items[index], index)
    }
  })

  await Promise.all(workers)
  return results
}

export interface ProcessingResult {
  indicationConfigs: number
  indicationResults: number
  strategyConfigs: number
  strategyPositions: number
  symbolsTotal: number
  symbolsProcessed: number
  symbolsWithoutData: number
  candlesProcessed: number
  errors: number
  duration: number
  // Interval-stepping metrics
  intervalsProcessed: number
  missingIntervalsLoaded: number
  timeframeSeconds: number
  rangeStartMs: number
  rangeEndMs: number
}

export class ConfigSetProcessor {
  private connectionId: string
  private epoch: number
  private indicationManager: IndicationConfigManager
  private strategyManager: StrategyConfigManager

  // Per-Set DB capacity used to clip the per-config indication-result and
  // strategy-position arrays returned from each calculation pass. This
  // value MUST track the operator-controlled `setCompactionFloor`
  // setting (Settings → System → Set Compaction → Compaction Floor) so
  // the per-pass slice does not artificially mask actual processed
  // counts in the dashboard.
  //
  // Read once at the start of each `processPrehistoricData` run (cheap,
  // already async) into `runtimeSetEntryCap`. Default 250 matches the
  // historical hard-coded value, so behaviour is unchanged for fresh
  // installs that haven't tuned the setting.
  private runtimeSetEntryCap: number = 250

  constructor(connectionId: string, epoch: number) {
    this.connectionId = connectionId
    this.epoch = epoch
    this.indicationManager = new IndicationConfigManager(connectionId)
    this.strategyManager = new StrategyConfigManager(connectionId)
  }

  /**
   * Resolve the per-Set entry cap from settings (`setCompactionFloor`).
   * Honours the same value the operator configured in Settings → System
   * → Set Compaction. Returns 250 (the legacy default) when the
   * setting is missing or invalid so behaviour is preserved.
   *
   * NOTE: this is called once per `processPrehistoricData` run. Per-call
   * lookup avoids stale closures on long-lived process instances.
   */
  private async resolveSetEntryCap(): Promise<number> {
    try {
      const settingsRaw = await getSettings("global_settings").catch(() => null)
      const settings: any = settingsRaw && typeof settingsRaw === "object" ? settingsRaw : {}
      const fromSettings = Number(settings.setCompactionFloor)
      if (Number.isFinite(fromSettings) && fromSettings >= 50 && fromSettings <= 100_000) {
        return Math.floor(fromSettings)
      }
    } catch { /* non-critical */ }
    return 250
  }

  /**
   * Initialize default config sets if they don't exist
   * Creates baseline configurations for indications and strategies
   */
  async initializeConfigSets(): Promise<{ indications: number; strategies: number }> {
    console.log(`[v0] [ConfigSetProcessor] Initializing config sets for ${this.connectionId}`)

    const existingIndications = await this.indicationManager.getAllConfigs()
    const existingStrategies = await this.strategyManager.getAllConfigs()

    let newIndications = 0
    let newStrategies = 0

    if (existingIndications.length === 0) {
      console.log(`[v0] [ConfigSetProcessor] Creating default indication configs...`)
      const indicationConfigs = await this.indicationManager.generateDefaultConfigs()
      newIndications = indicationConfigs.length
      console.log(`[v0] [ConfigSetProcessor] Created ${newIndications} indication configs`)
    } else {
      console.log(`[v0] [ConfigSetProcessor] Found ${existingIndications.length} existing indication configs`)
    }

    if (existingStrategies.length === 0) {
      console.log(`[v0] [ConfigSetProcessor] Creating default strategy configs...`)
      const strategyConfigs = await this.strategyManager.generateDefaultConfigs()
      newStrategies = strategyConfigs.length
      console.log(`[v0] [ConfigSetProcessor] Created ${newStrategies} strategy configs`)
    } else {
      console.log(`[v0] [ConfigSetProcessor] Found ${existingStrategies.length} existing strategy configs`)
    }

    return {
      indications: existingIndications.length + newIndications,
      strategies: existingStrategies.length + newStrategies,
    }
  }

  /**
   * Process prehistoric data through all config sets.
   * Processes ONLY missing time intervals (skips already-loaded ranges).
   * Steps through the full time range one timeframe interval at a time.
   *
   * @param symbols       - Symbols to process
   * @param rangeStart    - Start of the historical range (default: now - 1 day)
   * @param rangeEnd      - End of the historical range (default: now)
   * @param timeframeSec  - Timeframe interval in seconds (default: 1 = 1-second bars)
   */
  async processPrehistoricData(
    symbols: string[],
    rangeStart?: Date,
    rangeEnd?: Date,
    timeframeSec: number = 1
  ): Promise<ProcessingResult> {
    const startTime = Date.now()
    const now = new Date()
    const effectiveEnd = rangeEnd ?? now
    // Default fallback — 8 hours, matches engine-manager DEFAULT_RANGE_HOURS.
    const effectiveStart = rangeStart ?? new Date(now.getTime() - 8 * 60 * 60 * 1000)
    const intervalMs = timeframeSec * 1000

    // Symbol-level concurrency: process N symbols in parallel. Each symbol
    // then fans out its enabled indication/strategy configs in parallel.
    // Tunable via env (PREHISTORIC_SYMBOL_CONCURRENCY) — default 8.
    const SYMBOL_CONCURRENCY = Math.max(
      1,
      Math.min(32, Number(process.env.PREHISTORIC_SYMBOL_CONCURRENCY) || 8)
    )
    const CONFIG_CONCURRENCY = Math.max(
      1,
      Math.min(64, Number(process.env.PREHISTORIC_CONFIG_CONCURRENCY) || 24)
    )
    const CONFIG_TYPE_CONCURRENCY = Math.max(
      1,
      Math.min(16, Number(process.env.PREHISTORIC_CONFIG_TYPE_CONCURRENCY) || 8)
    )

    const initialSelection = await getCanonicalSymbolSelection(this.connectionId)
    const writerSelectionEpoch = initialSelection?.epoch || ""
    const canonicalSymbolsTotal = await canonicalTotalForSymbols(this.connectionId, symbols)
    const ownsCurrentSelection = await ownsCanonicalSymbolSelectionEpoch(this.connectionId, symbols, writerSelectionEpoch)
    const stillOwnsCurrentSelection = () => ownsCanonicalSymbolSelectionEpoch(this.connectionId, symbols, writerSelectionEpoch)

    console.log(
      `[v0] [ConfigSetProcessor] ▶ prehistoric start | symbols=${symbols.length} canonicalTotal=${canonicalSymbolsTotal} | ` +
      `range=${effectiveStart.toISOString()} → ${effectiveEnd.toISOString()} | ` +
      `timeframe=${timeframeSec}s | symbolConcurrency=${SYMBOL_CONCURRENCY} | configTypeConcurrency=${CONFIG_TYPE_CONCURRENCY} | configConcurrency=${CONFIG_CONCURRENCY}`
    )

    await initRedis()
    const client = getRedisClient()

    // Resolve the per-Set entry cap once for this whole run. Honours the
    // operator-controlled `setCompactionFloor` setting so the dashboard
    // counts (`indications_count`, `strategies_base_total`, the per-Set
    // DB lengths) reflect the actual configured ceiling instead of the
    // historical hard-coded 250.
    this.runtimeSetEntryCap = await this.resolveSetEntryCap()
    console.log(
      `[v0] [ConfigSetProcessor] per-Set entry cap = ${this.runtimeSetEntryCap} ` +
      `(from setCompactionFloor)`
    )

    // Mutable aggregates updated from parallel workers — guard with a lightweight
    // local function since JS is single-threaded inside the event loop there's
    // no true race, but this keeps the reads/writes explicit.
    let totalIndicationResults = 0
    let totalStrategyPositions = 0
    let symbolsProcessed = 0
    let symbolsWithoutData = 0
    let candlesProcessed = 0
    let errors = 0
    let totalIntervalsProcessed = 0
    let missingIntervalsLoaded = 0

    const tConfigsStart = Date.now()
    const [indicationConfigs, strategyConfigs] = await Promise.all([
      this.indicationManager.getEnabledConfigs(),
      this.strategyManager.getEnabledConfigs(),
    ])
    const tConfigsMs = Date.now() - tConfigsStart

    console.log(
      `[v0] [ConfigSetProcessor] loaded ${indicationConfigs.length} indication configs, ` +
      `${strategyConfigs.length} strategy configs (in ${tConfigsMs}ms)`
    )

    // Store range metadata for dashboard
    try {
      await client.hset(`prehistoric:${this.connectionId}`, {
        range_start: effectiveStart.toISOString(),
        range_end: effectiveEnd.toISOString(),
        timeframe_seconds: String(timeframeSec),
        ...(ownsCurrentSelection ? {
          symbol_selection_epoch: writerSelectionEpoch,
          symbols_total: String(canonicalSymbolsTotal),
        } : {}),
        symbol_concurrency: String(SYMBOL_CONCURRENCY),
        config_type_concurrency: String(CONFIG_TYPE_CONCURRENCY),
        indication_configs: String(indicationConfigs.length),
        strategy_configs: String(strategyConfigs.length),
        config_concurrency: String(CONFIG_CONCURRENCY),
        updated_at: new Date().toISOString(),
      })
    } catch { /* non-critical */ }

    const progressKey = `progression:${this.connectionId}`

    // Worker that processes a single symbol end-to-end. All DB writes inside
    // are fired with Promise.all where possible to minimise the await chain.
    const processOneSymbol = async (symbol: string): Promise<void> => {
      const tSymStart = Date.now()
      try {
        // --- Load all available candles for this symbol ---
        let candles: any[] = []

        const candlesRaw = await client.get(`market_data:${symbol}:candles`)
        if (candlesRaw) {
          candles = JSON.parse(candlesRaw)
        }

        // ── Fallback read switched from `:1m` → `:1s` (spec §7.3) ───
        //
        // The market-data loader was migrated to 1-second timeframe so
        // the legacy `:1m` suffix is no longer populated on fresh
        // deployments. The canonical `:candles` snapshot above is
        // still tried first; the `:1s` JSON envelope is the
        // authoritative fallback.
        if (!candles || candles.length === 0) {
          const marketDataRaw = await client.get(`market_data:${symbol}:1s`)
          if (marketDataRaw) {
            const marketDataObj = JSON.parse(marketDataRaw)
            if (marketDataObj?.candles) {
              candles = marketDataObj.candles
            }
          }
        }

        if (candles.length === 0) {
          console.log(`[v0] [ConfigSetProcessor] ⚠ no candles for ${symbol} — skipping`)
          symbolsWithoutData++
          if (!(await stillOwnsCurrentSelection())) {
            await logProgressionEvent(this.connectionId, "config_set_symbol_skipped_stale_selection", "info", `Ignoring stale prehistoric skip progress for ${symbol}`, {
              symbol,
              stage: "prehistoric",
              canonicalSymbolsTotal,
              staleSymbolsTotal: symbols.length,
            }).catch(() => {})
            return
          }
          // CRITICAL ("0/N stuck" + stalled progress-bar fix): a symbol with
          // no prehistoric candles must STILL count toward the processed
          // total, otherwise `symbols_processed` can never reach
          // `symbols_total` (dashboard sticks at "X/N") AND the percent bar
          // — computed from the local `symbolsProcessed` below — can never
          // reach 95%. Increment the local counter, add to the canonical SET
          // (single atomic source of truth), and mirror BOTH the distinct
          // count and the legacy `prehistoric_symbols_processed_count` field.
          // SADD is idempotent so a replay can't double-count.
          symbolsProcessed++
          try {
            const added = Number(await client.sadd(`prehistoric:${this.connectionId}:symbols`, symbol)) || 0
            await client.expire(`prehistoric:${this.connectionId}:symbols`, 86400)
            if (added > 0) {
              await client.hincrby(progressKey, "prehistoric_symbols_processed_count", 1)
            }
            const distinctSkipProcessed = clampProcessedToTotal(await client.scard(`prehistoric:${this.connectionId}:symbols`), canonicalSymbolsTotal)
            await client.hset(`prehistoric:${this.connectionId}`, {
              symbols_processed: String(distinctSkipProcessed),
            })
            // Advance the dashboard percent bar even for data-less symbols,
            // using the SAME `engine_progression` schema the main path writes.
            const totalSyms = Math.max(1, canonicalSymbolsTotal)
            const skipPct = Math.min(95, 15 + Math.round((symbolsProcessed / totalSyms) * 80))
            void setSettings(`engine_progression:${this.connectionId}`, {
              phase: "prehistoric_data",
              progress: skipPct,
              detail: `Prehistoric calc filling sets — ${symbolsProcessed}/${totalSyms} symbols processed (no data: ${symbol})`,
              sub_current: symbolsProcessed,
              sub_total: totalSyms,
              sub_item: symbol,
              connection_id: this.connectionId,
              updated_at: new Date().toISOString(),
            }).catch(() => { /* non-critical */ })
          } catch { /* non-critical */ }
          await logProgressionEvent(this.connectionId, "config_set_symbol_skipped", "warning", `No prehistoric candles for ${symbol}`, {
            symbol,
            stage: "prehistoric",
          })
          return
        }

        // --- Determine which time intervals are already processed ---
        const processedKey = `prehistoric:${this.connectionId}:${symbol}:processed_intervals`
        let processedIntervals: Set<number> = new Set()
        try {
          const processedRaw = await client.get(processedKey)
          if (processedRaw) {
            const arr: number[] = JSON.parse(processedRaw)
            processedIntervals = new Set(arr)
          }
        } catch { /* non-critical */ }

        // --- Step through time range interval by interval, processing only missing ones ---
        let currentTs = effectiveStart.getTime()
        const endTs = effectiveEnd.getTime()

        // Pre-sort candles by timestamp for faster bucket filtering.
        const candlesSorted = candles
          .map((c: any) => {
            const cTs = typeof c.timestamp === "number"
              ? c.timestamp
              : new Date(c.timestamp || c.time).getTime()
            return { ...c, _ts: cTs }
          })
          .sort((a: any, b: any) => a._ts - b._ts)

        const intervalCandles: any[] = []
        let symbolIntervalCount = 0
        let symbolMissingCount = 0

        // Use a single linear scan over pre-sorted candles instead of filtering
        // per-bucket. O(n+B) instead of O(n*B).
        let cursor = 0
        while (currentTs < endTs) {
          const bucketTs = Math.floor(currentTs / intervalMs) * intervalMs
          symbolIntervalCount++
          if (!processedIntervals.has(bucketTs)) {
            // Advance cursor to first candle >= bucketTs
            while (cursor < candlesSorted.length && candlesSorted[cursor]._ts < bucketTs) cursor++
            let hadMatch = false
            let probe = cursor
            while (probe < candlesSorted.length && candlesSorted[probe]._ts < bucketTs + intervalMs) {
              intervalCandles.push(candlesSorted[probe])
              probe++
              hadMatch = true
            }
            if (hadMatch) {
              symbolMissingCount++
              processedIntervals.add(bucketTs)
            }
          }
          currentTs += intervalMs
          if (symbolIntervalCount % 1000 === 0) {
            await yieldToEventLoop()
          }
        }

        totalIntervalsProcessed += symbolIntervalCount
        missingIntervalsLoaded += symbolMissingCount

        // Persist the updated processed-intervals set for this symbol (TTL = 25h)
        try {
          await client.set(processedKey, JSON.stringify([...processedIntervals]), { EX: 90000 })
        } catch { /* non-critical */ }

        // Merge interval candles with full candle array for processing
        const combinedCandles = intervalCandles.length > 0 ? intervalCandles : candlesSorted
        candlesProcessed += combinedCandles.length
        symbolsProcessed++

        // --- Write live progress to Redis hash (fire concurrently with computation) ---
        // Use the same canonical processed-symbol SET as the skip/error paths
        // before touching the legacy counter. A settings restart or duplicate
        // bootstrap can replay the same symbol; blind HINCRBY made the status
        // state report 30/15 symbols in 15-symbol live tests even though the
        // distinct processed set was correct. SADD gives us an idempotent
        // "new symbol" signal, then SCARD becomes the displayed count.
        const progressWrite = (async () => {
          if (!(await stillOwnsCurrentSelection())) return
          const added = Number(await client.sadd(`prehistoric:${this.connectionId}:symbols`, symbol).catch(() => 0)) || 0
          await client.expire(`prehistoric:${this.connectionId}:symbols`, 86400).catch(() => 0)
          if (added > 0) {
            await client.hincrby(progressKey, "prehistoric_symbols_processed_count", 1).catch(() => 0)
          }
          const distinctProcessed = clampProcessedToTotal(await client.scard(`prehistoric:${this.connectionId}:symbols`).catch(() => 0), canonicalSymbolsTotal)
          await Promise.all([
            client.hincrby(progressKey, "prehistoric_candles_processed", combinedCandles.length),
            client.hset(progressKey, {
              prehistoric_symbols_processed_count: String(distinctProcessed),
              prehistoric_current_symbol: symbol,
              prehistoric_intervals_processed: String(totalIntervalsProcessed),
              prehistoric_missing_loaded: String(missingIntervalsLoaded),
              prehistoric_timeframe_seconds: String(timeframeSec),
            }),
            client.hset(`prehistoric:${this.connectionId}`, {
              symbols_processed: String(distinctProcessed),
            }),
            client.expire(progressKey, 7 * 24 * 60 * 60),
          ])
        })().catch(() => { /* non-critical */ })

        // --- Run indications + strategies in parallel for this symbol ---
        const tCalcStart = Date.now()
        const [indicationResults, strategyPositions] = await Promise.all([
          this.processIndicationConfigs(symbol, combinedCandles, indicationConfigs, CONFIG_CONCURRENCY, CONFIG_TYPE_CONCURRENCY),
          this.processStrategyConfigs(symbol, combinedCandles, strategyConfigs, CONFIG_CONCURRENCY, CONFIG_TYPE_CONCURRENCY),
        ])
        const tCalcMs = Date.now() - tCalcStart

        totalIndicationResults += indicationResults
        totalStrategyPositions += strategyPositions

        // Fan-out the counter writes & completion marker.
        // NOTE: Track prehistoric stats separately so they don't bleed into
        // realtime counts. The `indications_count` and `strategies_count` are
        // realtime-authoritative (written by engine-manager). Prehistoric phase
        // writes to separate `prehistoric_indications_total` and
        // `prehistoric_strategies_total` keys. This prevents the "jumped counters"
        // effect when transitioning from setup to live trading.
        //
        // CRITICAL ("0/N stuck" fix): `symbols_processed` is derived from the
        // cardinality of the `prehistoric:{id}:symbols` SET, NOT the shared
        // mutable `symbolsProcessed` local. With SYMBOL_CONCURRENCY parallel
        // workers, writing `String(symbolsProcessed)` raced — an out-of-order
        // async write could stamp a STALE (lower) value over a newer one,
        // freezing the dashboard at "X/N". SADD + SCARD is order-independent
        // and idempotent, so the distinct count is always monotonic and exact.
        if (!(await stillOwnsCurrentSelection())) {
          console.log(`[v0] [ConfigSetProcessor] stale symbol-selection progress ignored for ${symbol} (${symbols.length} symbols; canonical=${canonicalSymbolsTotal})`)
          return
        }
        await client.sadd(`prehistoric:${this.connectionId}:symbols`, symbol)
        const distinctProcessed = clampProcessedToTotal(await client
          .scard(`prehistoric:${this.connectionId}:symbols`)
          .catch(() => symbolsProcessed), canonicalSymbolsTotal)
        await Promise.all([
          progressWrite,
          client.hincrby(progressKey, "prehistoric_indications_total", indicationResults),
          client.hincrby(progressKey, "prehistoric_strategies_total", strategyPositions),
          client.expire(progressKey, 7 * 24 * 60 * 60),
          client.expire(`prehistoric:${this.connectionId}:symbols`, 86400),
          client.hset(`prehistoric:${this.connectionId}`, {
            candles_loaded: String(candlesProcessed),
            symbols_processed: String(distinctProcessed),
            intervals_processed: String(totalIntervalsProcessed),
            missing_intervals: String(missingIntervalsLoaded),
          }),
          // Bump the canonical `prehistoric_cycles_completed` counter and
          // mirror the processed symbols into the hash via the shared
          // ProgressionStateManager primitive. Without this call, the
          // engine-boot prehistoric path wrote per-field stats directly
          // but left `prehistoric_cycles_completed` at 0 forever — which
          // broke `/api/system/verify-engine` (reads the field), the
          // `progression/[id]/stats` route, and every dashboard that
          // distinguishes "prehistoric done" from "never ran".
          ProgressionStateManager.incrementPrehistoricCycle(this.connectionId, symbol).catch(() => { /* non-critical */ }),
        ]).catch(() => { /* non-critical */ })

        // ── Live phase progression update (per-symbol cadence) ─────────
        // Push the actual percent + sub_progress (X/Y symbols) into
        // `engine_progression:{id}` so the dashboard progress bar
        // advances in real time as parallel workers tick off symbols.
        // The phase percent maps the prehistoric work onto the
        // 15 → 95 range (live_trading @ 100 is set by the engine boot
        // path's post-prehistoric handler). Fire-and-forget — a stuck
        // Redis write should never delay the next symbol.
        try {
          // Use the monotonic SCARD-derived `distinctProcessed` (NOT the racy
          // `symbolsProcessed` local) for BOTH the percent and the X/Y display
          // so the progress bar and the "symbols processed of N" label can
          // never regress under parallel workers — they advance in lockstep
          // with the authoritative distinct-symbol set.
          const total = Math.max(1, canonicalSymbolsTotal)
          const pct = Math.min(95, 15 + Math.round((distinctProcessed / total) * 80))
          void setSettings(`engine_progression:${this.connectionId}`, {
            phase: "prehistoric_data",
            progress: pct,
            detail: `Prehistoric calc filling sets — ${distinctProcessed}/${total} symbols processed`,
            sub_current: distinctProcessed,
            sub_total: total,
            sub_item: symbol,
            connection_id: this.connectionId,
            updated_at: new Date().toISOString(),
          }).catch(() => { /* non-critical */ })
        } catch { /* non-critical */ }

        const tSymMs = Date.now() - tSymStart
        console.log(
          `[v0] [ConfigSetProcessor] ✓ ${symbol} | candles=${combinedCandles.length} | ` +
          `intervals=${symbolIntervalCount} (missing=${symbolMissingCount}) | ` +
          `indications=${indicationResults} | strategies=${strategyPositions} | ` +
          `calc=${tCalcMs}ms | total=${tSymMs}ms`
        )
      } catch (error) {
        console.error(`[v0] [ConfigSetProcessor] ✗ ${symbol}:`, error instanceof Error ? error.message : String(error))
        errors++
        if (!(await stillOwnsCurrentSelection())) {
          await logProgressionEvent(this.connectionId, "config_set_symbol_error_stale_selection", "info", `Ignoring stale prehistoric error progress for ${symbol}`, {
            symbol,
            error: error instanceof Error ? error.message : String(error),
            canonicalSymbolsTotal,
            staleSymbolsTotal: symbols.length,
          }).catch(() => {})
          return
        }
        // CRITICAL ("stuck below 100%" fix): a symbol that throws mid-process
        // must STILL count toward progress, otherwise the SCARD-derived
        // distinct count never reaches N and the bar freezes forever. Mirror
        // the skip-branch accounting: add to the canonical SET (idempotent),
        // bump the legacy counter, and advance the dashboard percent using the
        // monotonic distinct count.
        symbolsProcessed++
        try {
          const added = Number(await client.sadd(`prehistoric:${this.connectionId}:symbols`, symbol)) || 0
          await client.expire(`prehistoric:${this.connectionId}:symbols`, 86400)
          if (added > 0) {
            await client.hincrby(progressKey, "prehistoric_symbols_processed_count", 1)
          }
          const distinctErrProcessed = clampProcessedToTotal(await client.scard(`prehistoric:${this.connectionId}:symbols`), canonicalSymbolsTotal)
          await client.hset(`prehistoric:${this.connectionId}`, {
            symbols_processed: String(distinctErrProcessed),
          })
          const totalSyms = Math.max(1, canonicalSymbolsTotal)
          const errPct = Math.min(95, 15 + Math.round((distinctErrProcessed / totalSyms) * 80))
          void setSettings(`engine_progression:${this.connectionId}`, {
            phase: "prehistoric_data",
            progress: errPct,
            detail: `Prehistoric calc filling sets — ${distinctErrProcessed}/${totalSyms} symbols processed (error: ${symbol})`,
            sub_current: distinctErrProcessed,
            sub_total: totalSyms,
            sub_item: symbol,
            connection_id: this.connectionId,
            updated_at: new Date().toISOString(),
          }).catch(() => { /* non-critical */ })
        } catch { /* non-critical */ }
        await logProgressionEvent(this.connectionId, "config_set_symbol_error", "error", `Prehistoric processing failed for ${symbol}`, {
          symbol,
          error: error instanceof Error ? error.message : String(error),
        })
      }
    }

    // Fixed-size worker pool. We grab symbols off the queue as workers finish.
    const queue = [...symbols]
    const workers: Promise<void>[] = []
    const spawnWorker = async (): Promise<void> => {
      while (queue.length > 0) {
        const sym = queue.shift()
        if (!sym) break
        await processOneSymbol(sym)
      }
    }
    for (let i = 0; i < Math.min(SYMBOL_CONCURRENCY, symbols.length); i++) {
      workers.push(spawnWorker())
    }
    await Promise.all(workers)

    const duration = Date.now() - startTime
    const result: ProcessingResult = {
      indicationConfigs: indicationConfigs.length,
      indicationResults: totalIndicationResults,
      strategyConfigs: strategyConfigs.length,
      strategyPositions: totalStrategyPositions,
      symbolsTotal: canonicalSymbolsTotal,
      symbolsProcessed: clampProcessedToTotal(symbolsProcessed, canonicalSymbolsTotal),
      symbolsWithoutData,
      candlesProcessed,
      errors,
      duration,
      intervalsProcessed: totalIntervalsProcessed,
      missingIntervalsLoaded,
      timeframeSeconds: timeframeSec,
      rangeStartMs: effectiveStart.getTime(),
      rangeEndMs: effectiveEnd.getTime(),
    }

    console.log(
      `[v0] [ConfigSetProcessor] Prehistoric processing complete: ` +
      `${totalIndicationResults} indication results, ${totalStrategyPositions} positions in ${duration}ms`
    )

    await logProgressionEvent(this.connectionId, "config_set_processing", "info", 
      `Processed prehistoric data through config sets`, result)

    await logProgressionEvent(this.connectionId, "config_set_processing_summary", errors > 0 ? "warning" : "info", "Prehistoric config processing summary", {
      symbolsTotal: result.symbolsTotal,
      symbolsProcessed: result.symbolsProcessed,
      symbolsWithoutData: result.symbolsWithoutData,
      candlesProcessed: result.candlesProcessed,
      indicationConfigs: result.indicationConfigs,
      strategyConfigs: result.strategyConfigs,
      indicationResults: result.indicationResults,
      strategyPositions: result.strategyPositions,
      errors: result.errors,
      durationMs: result.duration,
    })

    // ── Aggregate per-stage avg profit factor from prehistoric positions ──
    //
    // The realtime strategy-coordinator writes
    // `strategy_detail:{connId}:{base|main|real}.avg_profit_factor` once it
    // starts running. During pure prehistoric processing those keys stay
    // empty, so the dashboard's Base/Main/Real PF tiles read 0/— even
    // though we just generated thousands of historic positions with full
    // PnL data. Spec ask: "Show / Add also Average Profitfactors for
    // Strategies Base, Main, Real (for Historic Processing Info / Stats)."
    //
    // We compute one aggregate PF over all prehistoric position results
    // and mirror it into the three stage hashes. Per-stage tiering does
    // not exist in the prehistoric data model (StrategyConfig has no
    // tier field), so the same aggregate is written across all three;
    // once the realtime strategy-coordinator runs, its tier-specific
    // writes naturally overwrite these prehistoric placeholders. We use
    // SETNX-style logic via plain HSET because callers downstream
    // already accept the field whenever it is present.
    //
    // PF = sum(positive results %) / |sum(negative results %)|.
    // Capped at 9.999 so a no-loss prehistoric run renders cleanly.
    try {
      let posSum = 0
      let negAbsSum = 0
      let resultCount = 0
      const tStart = Date.now()
      // Cap concurrency on the hot prehistoric path — for very large
      // strategy config counts we don't want to fan out an unbounded
      // number of LRANGE commands at once.
      const PF_SCAN_CONCURRENCY = 16
      const queue = strategyConfigs.slice()
      const workers: Promise<void>[] = []
      for (let w = 0; w < Math.min(PF_SCAN_CONCURRENCY, queue.length); w++) {
        workers.push((async () => {
          while (true) {
            const cfg = queue.shift()
            if (!cfg) return
            try {
              const setKey = `strategy:${this.connectionId}:config:${cfg.id}:positions`
              const entries = (await client.lrange(setKey, 0, StrategyConfigManager.MAX_POSITIONS - 1)) || []
              for (const entry of entries) {
                if (!entry) continue
                // ── Closed-only gate (spec: "Main Sets / Pos Coord ones must
                //    evaluate previous CLOSED pseudo positions, not opened ones") ──
                //
                // Entries are produced via `StrategyConfigManager.serializeSetEntry`,
                // which writes a POSITIONAL "|"-delimited tuple:
                //   entry_time|symbol|entry_price|take_profit|stop_loss|
                //   status|result|exit_time|exit_price
                //
                // The previous parser tried two branches that never matched
                // real production rows:
                //   (1) `JSON.parse` — only legacy payloads use that
                //   (2) regex `\bresult=…` — assumed key=value pairs that
                //       this serializer does NOT produce
                // The result was `resultCount` permanently 0 — and worse,
                // had parsing succeeded the aggregate would have summed
                // OPEN positions because the prehistoric fill path appends
                // `status:"open"` rows alongside `status:"closed"` ones.
                //
                // Now: parse with the canonical `StrategyConfigManager.parseEntry`
                // helper (already used by `getLatestPosition` / `getStats`),
                // then hard-gate on `status === "closed"`. Floating
                // mark-to-market PnL on still-open prehistoric trades is
                // excluded from the aggregate that mirrors into
                //   strategy_detail:{base|main|real}.avg_profit_factor
                //   progression:{id}.strategy_{base|main|real}_avg_profit_factor
                //   prehistoric:{id}.historic_avg_profit_factor
                // — all of which feed the Main-stage position-factor
                // coordination layer.
                const parsed = StrategyConfigManager.parseEntry(String(entry))
                if (!parsed) continue
                if (parsed.status !== "closed") continue
                const resultPct = Number(parsed.result)
                if (!Number.isFinite(resultPct)) continue
                if (resultPct > 0) posSum += resultPct
                else if (resultPct < 0) negAbsSum += Math.abs(resultPct)
                resultCount++
              }
            } catch (err) {
              console.warn(
                `[v0] [ConfigSetProcessor] PF scan failed for ${cfg.id}:`,
                err instanceof Error ? err.message : String(err),
              )
            }
          }
        })())
      }
      await Promise.all(workers)

      // Always write the PF field so the dashboard's "Historic PF" tile
      // renders immediately, even when no closed positions exist yet.
      // If positions exist, compute; otherwise default to 0 so the UI
      // shows a valid value instead of undefined/blank.
      let pfStr = "0.0000"
      let pfSource = "no_closed_positions"
      if (resultCount > 0 && (posSum > 0 || negAbsSum > 0)) {
        const rawPF = negAbsSum > 0 ? posSum / negAbsSum : 9.999 // all-wins ceiling
        const aggregatePF = Math.min(9.999, Math.max(0, rawPF))
        pfStr = aggregatePF.toFixed(4)
        pfSource = "prehistoric_aggregate"
      }
      
      const { hsetProgression } = await import("./progression-writes")
      const stageWrites: Promise<any>[] = []
      for (const stage of ["base", "main", "real"] as const) {
        const stageKey = `strategy_detail:${this.connectionId}:${stage}`
        stageWrites.push(
          client.hset(stageKey, {
            avg_profit_factor: pfStr,
            // Mark provenance so anyone debugging the dashboard can tell
            // this PF was synthesised from prehistoric positions and not
            // from realtime strategy-coordinator. Cleared on the first
            // realtime write because that flow doesn't set this field.
            avg_profit_factor_source: pfSource,
            avg_profit_factor_count: String(resultCount),
            avg_profit_factor_calc_at: new Date().toISOString(),
          }),
        )
        stageWrites.push(client.expire(stageKey, 86400))
        // Also mirror into the canonical progression hash so the
        // legacy fallback chain in the /stats route can find it
        // even if the per-stage detail hash is unreadable for any
        // reason. Stage-specific keys avoid clobbering the
        // realtime writer's own writes.
        // Use validated wrapper to prevent stale writes
        stageWrites.push(
          hsetProgression(this.connectionId, `strategy_${stage}_avg_profit_factor`, pfStr, {
            connectionId: this.connectionId,
            epoch: this.epoch,
            logStaleRejects: false,
          }),
        )
      }
      // Single overall key for the dashboard's "Historic PF" surface.
      // Always written (even with 0.0000 if no closed positions) so the
      // UI field is never undefined.
      stageWrites.push(
        client.hset(`prehistoric:${this.connectionId}`, {
          historic_avg_profit_factor: pfStr,
          historic_avg_profit_factor_count: String(resultCount),
          historic_avg_profit_factor_at: new Date().toISOString(),
        }),
      )
      await Promise.all(stageWrites)
      
      if (resultCount > 0) {
        console.log(
          `[v0] [ConfigSetProcessor] Historic PF aggregated: ${pfStr} ` +
          `(across ${resultCount} positions, +${posSum.toFixed(2)}% / ` +
          `-${negAbsSum.toFixed(2)}%, ${Date.now() - tStart}ms)`,
        )
      } else {
        console.log(
          `[v0] [ConfigSetProcessor] Historic PF initialized: 0.0000 ` +
          `(no closed positions yet, scan ${Date.now() - tStart}ms)`,
        )
      }
    } catch (err) {
      // Aggregate PF is a UX nicety — never fail the prehistoric run.
      console.warn(
        `[v0] [ConfigSetProcessor] Historic PF aggregation failed:`,
        err instanceof Error ? err.message : String(err),
      )
    }

    // Flip `prehistoric_phase_active` to "false" and refresh last_update.
    // Downstream readers (verify-engine API, progression stats API, the
    // dashboard prehistoric card) use this as the authoritative "historical
    // calc is done" signal. Without this call the phase stayed `active`
    // forever even though processing had finished.
    try {
      await ProgressionStateManager.completePrehistoricPhase(this.connectionId, symbols.length)
    } catch (err) {
      console.warn(
        `[v0] [ConfigSetProcessor] completePrehistoricPhase failed:`,
        err instanceof Error ? err.message : String(err),
      )
    }

    // Persist the authoritative "historical processing last-run" metadata.
    // Lives at `prehistoric:{connId}` (same hash that carries counters
    // like `candles_loaded` and `symbols_processed`) so every consumer
    // that already reads that hash picks up the timestamps for free:
    //
    //   - last_run_at          : ISO timestamp of the run END
    //   - last_run_started_at  : ISO timestamp of the run START
    //   - processing_duration_ms : total ms spent in processPrehistoricData
    //   - last_run_errors      : error count from the just-finished run
    //   - last_run_symbols     : symbols actually processed this run
    //
    // The UI prehistoric card / progression dashboard surfaces these
    // directly. Prior behaviour: no timestamps at all — the "last
    // processed" column was permanently blank. TTL matches the sibling
    // keys (24h) so state doesn't linger forever after a disconnect.
    try {
      const client = getRedisClient()
      const finishedAt = new Date()
      await client.hset(`prehistoric:${this.connectionId}`, {
        last_run_at: finishedAt.toISOString(),
        last_run_at_ms: String(finishedAt.getTime()),
        last_run_started_at: new Date(startTime).toISOString(),
        last_run_started_at_ms: String(startTime),
        processing_duration_ms: String(duration),
        last_run_errors: String(errors),
        last_run_symbols: String(symbolsProcessed),
        last_run_candles: String(candlesProcessed),
        last_run_indication_results: String(totalIndicationResults),
        last_run_strategy_positions: String(totalStrategyPositions),
      })
      await client.expire(`prehistoric:${this.connectionId}`, 86400)
    } catch (err) {
      console.warn(
        `[v0] [ConfigSetProcessor] Failed to persist last-run metadata:`,
        err instanceof Error ? err.message : String(err),
      )
    }

    return result
  }

  /**
   * Process candles through all indication configs.
   * Each config calculates independently and runs in parallel. Results for a
   * single config are written as a single batched lpush to minimise Redis ops.
   */
  private async processIndicationConfigs(
    symbol: string,
    candles: any[],
    configs: IndicationConfig[],
    concurrency: number,
    typeConcurrency: number,
  ): Promise<number> {
    if (configs.length === 0) return 0

    const configTypeGroups = groupConfigsByType(configs)
    const perTypeResults = await mapWithConcurrency(
      configTypeGroups,
      typeConcurrency,
      async ([type, typeConfigs]) => {
        const perConfigResults = await mapWithConcurrency(
          typeConfigs,
          concurrency,
          async (config) => {
            try {
              await yieldToEventLoop()
              const results = this.calculateIndicationResults(symbol, candles, config)
              if (results.length === 0) return 0
              if (typeof (this.indicationManager as any).addResults === "function") {
                await (this.indicationManager as any).addResults(config.id, results)
              } else {
                // Fallback: fire in parallel instead of sequential awaits.
                await Promise.all(results.map((r) => this.indicationManager.addResult(config.id, r)))
              }
              return results.length
            } catch (error) {
              console.error(
                `[v0] [ConfigSetProcessor] ✗ indication config ${config.id} (${type}):`,
                error instanceof Error ? error.message : String(error),
              )
              return 0
            }
          },
        )
        return perConfigResults.reduce((sum, n) => sum + n, 0)
      },
    )

    return perTypeResults.reduce((sum, n) => sum + n, 0)
  }

  /**
   * Calculate indication results for a specific config
   * Uses config parameters to generate signals
   */
  private calculateIndicationResults(
    symbol: string,
    candles: any[],
    config: IndicationConfig
  ): IndicationResult[] {
    const results: IndicationResult[] = []
    const { steps, drawdown_ratio, active_ratio } = config

    if (!candles || candles.length < steps) {
      return results
    }

    const pricePoints = candles
      .map((c: any) => ({
        price: parseFloat(c.close || c.price || 0),
        timestamp: c?.timestamp || c?.time || new Date().toISOString(),
      }))
      .filter((p: any) => p.price > 0)
    const prices = pricePoints.map((p: any) => p.price)

    if (prices.length < steps) {
      return results
    }

    // ── Adaptive signal threshold ───────────────────────────────────────
    // Previously the gate was a hard-coded `adjustedMagnitude > 0.005`
    // (0.5%). That works on live exchange data (real volatility) but in the
    // sandbox the exchange fetch fails and we fall back to SYNTHETIC candles
    // that step only ~±0.0167%/bar. The windowed-average delta on that data
    // is ~0.01–0.05% — always below 0.5% — so prehistoric produced ZERO
    // indications (verified: candles=99 → indications=0) even though the
    // identical candles yielded strategies. That left every prehistoric Set
    // with no indication context.
    //
    // Fix: scale the threshold to the series' own volatility. We measure the
    // mean absolute bar-to-bar relative move and require the windowed delta
    // to exceed a fraction of it, clamped to a sane band. On live data this
    // resolves close to the original 0.5%; on flat synthetic data it drops
    // proportionally so meaningful relative moves still register.
    let volSum = 0
    let volN = 0
    for (let k = 1; k < prices.length; k++) {
      const prev = prices[k - 1]
      if (prev > 0) {
        volSum += Math.abs(prices[k] - prev) / prev
        volN++
      }
    }
    const avgBarVol = volN > 0 ? volSum / volN : 0
    // Threshold = 1.5× the typical bar move, clamped to [0.0002, 0.005].
    // Upper clamp preserves the legacy 0.5% ceiling for high-volatility data;
    // lower clamp keeps a noise floor so a dead-flat series still gates out.
    const signalThreshold = Math.min(0.005, Math.max(0.0002, avgBarVol * 1.5))

    for (let i = 0; i <= prices.length - steps; i++) {
      const windowPrices = prices.slice(i, i + steps)
      const firstHalf = windowPrices.slice(0, Math.floor(steps / 2))
      const secondHalf = windowPrices.slice(Math.floor(steps / 2))

      if (firstHalf.length < 2 || secondHalf.length < 2) continue

      const firstAvg = firstHalf.reduce((a: number, b: number) => a + b, 0) / firstHalf.length
      const secondAvg = secondHalf.reduce((a: number, b: number) => a + b, 0) / secondHalf.length

      const direction = secondAvg > firstAvg ? 1 : -1
      const magnitude = Math.abs(secondAvg - firstAvg) / firstAvg

      const adjustedMagnitude = magnitude * (1 - drawdown_ratio * 0.5) * active_ratio

      let signal: "buy" | "sell" | "neutral" = "neutral"
      let value = 0

      if (adjustedMagnitude > signalThreshold) {
        if (direction > 0) {
          signal = "buy"
          value = adjustedMagnitude * 100
        } else {
          signal = "sell"
          value = -adjustedMagnitude * 100
        }
      }

      if (signal !== "neutral") {
        const candle = pricePoints[i + steps - 1] || pricePoints[i]
        results.push({
          timestamp: candle?.timestamp || new Date().toISOString(),
          symbol,
          value,
          signal,
          confidence: Math.min(0.95, 0.5 + adjustedMagnitude),
        })
      }
    }

    // Honour the operator-configured per-Set entry cap (default 250 to
    // preserve legacy behaviour). Slicing per-config keeps Set size bounded
    // and the displayed totals in the dashboard now reflect the configured
    // ceiling rather than a hard-coded magic number.
    return results.slice(0, this.runtimeSetEntryCap)
  }

  /**
   * Process candles through all strategy configs in parallel.
   * Positions generated per config are written as a single batched lpush.
   */
  private async processStrategyConfigs(
    symbol: string,
    candles: any[],
    configs: StrategyConfig[],
    concurrency: number,
    typeConcurrency: number,
  ): Promise<number> {
    if (configs.length === 0) return 0

    // ── Systemwide fix: prehistoric must populate pos_history ───────────
    // The Main/Real min-pos gates (mainEvalPosCount / realEvalPosCount,
    // default 15/10) read `baseSet.prevPos.count` (sourced from the
    // pos_history:* hashes) to decide whether a Base Set has enough
    // historic context to be promoted. If this is empty when realtime
    // starts, the gates skip every Set and Main/Real stay 0 forever —
    // the user's "no sets evaluated" symptom.
    //
    // recordPosClosed() is what populates pos_history. It was previously
    // only called by the live close path (pseudo-position-manager.ts).
    // We now mirror every closed prehistoric position into pos_history
    // through the same primitive, batched into one Redis pipeline per
    // symbol-config so the round-trip cost stays bounded even when
    // a single config produces hundreds of historic closes.
    //
    // Spec: "Make sure prehistoric progress works completely correct
    //   with created sets data and then start realtime progress, AFTER
    //   prehistoric has finished, fix systemwide."
    const { recordPosClosed } = await import("@/lib/pos-history")
    const piClient = getRedisClient()

    const configTypeGroups = groupConfigsByType(configs)
    const perTypeCounts = await mapWithConcurrency(
      configTypeGroups,
      typeConcurrency,
      async ([type, typeConfigs]) => {
        const perConfigCounts = await mapWithConcurrency(
          typeConfigs,
          concurrency,
          async (config) => {
            try {
              await yieldToEventLoop()
              const positions = this.calculateStrategyPositions(symbol, candles, config)
              if (positions.length === 0) return 0
              if (typeof (this.strategyManager as any).addPositions === "function") {
                await (this.strategyManager as any).addPositions(config.id, positions)
              } else {
                await Promise.all(positions.map((p) => this.strategyManager.addPosition(config.id, p)))
              }

              // ── Mirror closed positions into pos_history (systemwide fix) ──
              // Compose every closed historic position into ONE pipeline so
              // the per-config cost is one round-trip regardless of fill
              // count. Open prehistoric tails (the trailing in-position row
              // emitted at end-of-range) are excluded — recordPosClosed
              // semantically means "one closed trade observed", and
              // including open tails would over-count the count/wins/loss
              // accumulators feeding the Main gate.
              const closed = positions.filter((p) => p.status === "closed")
              if (closed.length > 0) {
                try {
                  const pipeline = piClient.multi()
                  for (const p of closed) {
                    const direction = p.direction === "short" ? "short" : "long"
                    const indicationType = p.indication_type || config.type || "unknown"
                    const resultPct = Number(p.result) || 0
                    // Per-position drawdown TIME = how long the trade was held
                    // (entry → exit), in minutes. Both fields are either epoch-ms
                    // numbers or ISO strings (see the prices[].time origin), so we
                    // normalise to ms before differencing. Previously this was
                    // hardcoded to 0, which made the downstream DDT gate a dead
                    // no-op (Set.avgDrawdownTime was always 0). The realised
                    // duration is the correct signal: a Set that sits in trades
                    // for hours has materially worse drawdown-time risk than one
                    // that resolves in minutes, and the Main/Real gate is meant
                    // to reject the former.
                    const toMs = (t: unknown): number => {
                      if (typeof t === "number") return t
                      if (typeof t === "string") {
                        const n = Number(t)
                        if (Number.isFinite(n) && n > 0) return n
                        const parsed = Date.parse(t)
                        return Number.isFinite(parsed) ? parsed : 0
                      }
                      return 0
                    }
                    const entryMs = toMs(p.entry_time)
                    const exitMs = toMs(p.exit_time)
                    const drawdownMinutes =
                      entryMs > 0 && exitMs > entryMs ? (exitMs - entryMs) / 60000 : 0
                    recordPosClosed({
                      connectionId: this.connectionId,
                      symbol: p.symbol || symbol,
                      indicationType,
                      direction,
                      pnl: resultPct,
                      drawdownMinutes,
                      // Prehistoric backtest positions don't track quantity,
                      // so position cost is not available. Live positions in
                      // pseudo-position-manager pass both entryPrice and quantity.
                      entryPrice: p.entry_price,
                      pipeline,
                    })
                  }
                  await (pipeline as any).exec()
                } catch (piErr) {
                  // Non-critical — pos_history is observability/gate metadata.
                  // We never let it block the prehistoric run.
                  console.warn(
                    `[v0] [ConfigSetProcessor] pos_history mirror failed for ${config.id}:`,
                    piErr instanceof Error ? piErr.message : String(piErr),
                  )
                }
              }

              return positions.length
            } catch (error) {
              console.error(
                `[v0] [ConfigSetProcessor] ✗ strategy config ${config.id} (${type}):`,
                error instanceof Error ? error.message : String(error),
              )
              return 0
            }
          },
        )
        return perConfigCounts.reduce((sum, n) => sum + n, 0)
      },
    )

    return perTypeCounts.reduce((sum, n) => sum + n, 0)
  }

  /**
   * Calculate pseudo positions for a specific strategy config
   * Simulates trading with the config parameters
   */
  private calculateStrategyPositions(
    symbol: string,
    candles: any[],
    config: StrategyConfig
  ): PseudoPosition[] {
    const positions: PseudoPosition[] = []
    const { position_cost_step, takeprofit, stoploss, type } = config

    if (!candles || candles.length < position_cost_step * 2) {
      return positions
    }

    const prices = candles.map((c: any) => ({
      price: parseFloat(c.close || c.price || 0),
      time: c.timestamp || c.time || new Date().toISOString(),
    })).filter((p: any) => p.price > 0)

    let inPosition = false
    let entryPrice = 0
    let entryTime = ""
    let positionSide: "long" | "short" = "long"

    let rollingSum = prices.slice(0, position_cost_step).reduce((sum: number, p: any) => sum + p.price, 0)

    for (let i = position_cost_step; i < prices.length; i++) {
      const currentPrice = prices[i].price
      const currentTime = prices[i].time
      const avgPrice = rollingSum / position_cost_step

      if (!inPosition) {
        const priceDiff = (currentPrice - avgPrice) / avgPrice
        
        if (Math.abs(priceDiff) > 0.002) {
          inPosition = true
          entryPrice = currentPrice
          entryTime = currentTime
          positionSide = priceDiff > 0 ? "long" : "short"
        }
      } else {
        const pnl = positionSide === "long"
          ? (currentPrice - entryPrice) / entryPrice
          : (entryPrice - currentPrice) / entryPrice
        const netPnlPct = calculatePseudoClosePnl({
          entryPrice,
          currentPrice,
          quantity: 1,
          side: positionSide,
        }).netPnlPct

        const takeProfitHit = pnl >= takeprofit
        const stopLossHit = pnl <= -stoploss

        if (takeProfitHit || stopLossHit) {
          positions.push({
            entry_time: entryTime,
            symbol,
            entry_price: entryPrice,
            take_profit: entryPrice * (1 + (positionSide === "long" ? takeprofit : -takeprofit)),
            stop_loss: entryPrice * (1 + (positionSide === "long" ? -stoploss : stoploss)),
            status: "closed",
            result: netPnlPct,
            exit_time: currentTime,
            exit_price: currentPrice,
            // Carry direction + indication_type into the in-memory
            // PseudoPosition so the prehistoric write path
            // (processStrategyConfigs) can populate pos_history with
            // the correct (symbol × type × long|short) bucket. The
            // legacy "|"-delimited Set serialization in
            // StrategyConfigManager.serializeEntry intentionally
            // ignores these — they are runtime-only metadata for the
            // historic write fan-out.
            direction: positionSide,
            indication_type: type,
          })

          inPosition = false
        }
      }

      rollingSum += currentPrice - prices[i - position_cost_step].price
    }

    if (inPosition && prices.length > 0) {
      const lastPrice = prices[prices.length - 1].price
      const lastTime = prices[prices.length - 1].time
      const pnl = positionSide === "long"
        ? (lastPrice - entryPrice) / entryPrice
        : (entryPrice - lastPrice) / entryPrice
      const netPnlPct = calculatePseudoClosePnl({
        entryPrice,
        currentPrice: lastPrice,
        quantity: 1,
        side: positionSide,
      }).netPnlPct

      positions.push({
        entry_time: entryTime,
        symbol,
        entry_price: entryPrice,
        take_profit: entryPrice * (1 + (positionSide === "long" ? takeprofit : -takeprofit)),
        stop_loss: entryPrice * (1 + (positionSide === "long" ? -stoploss : stoploss)),
        status: "open",
        result: netPnlPct,
        direction: positionSide,
        indication_type: type,
      })
    }

    // Honour the operator-configured per-Set entry cap (see
    // `resolveSetEntryCap`). Default 250 — bumping the Set Compaction
    // Floor in Settings → System raises this ceiling for every prehistoric
    // strategy pass without code changes.
    return positions.slice(0, this.runtimeSetEntryCap)
  }

  /**
   * Get stats for all config sets
   */
  async getConfigSetStats(): Promise<{
    indications: { total: number; enabled: number; totalResults: number }
    strategies: { total: number; enabled: number; totalPositions: number }
  }> {
    const indicationConfigs = await this.indicationManager.getAllConfigs()
    const enabledIndications = indicationConfigs.filter(c => c.enabled)
    const strategyConfigs = await this.strategyManager.getAllConfigs()
    const enabledStrategies = strategyConfigs.filter(c => c.enabled)

    let totalIndicationResults = 0
    for (const config of enabledIndications) {
      totalIndicationResults += await this.indicationManager.getResultCount(config.id)
    }

    let totalStrategyPositions = 0
    for (const config of enabledStrategies) {
      totalStrategyPositions += await this.strategyManager.getPositionCount(config.id)
    }

    return {
      indications: {
        total: indicationConfigs.length,
        enabled: enabledIndications.length,
        totalResults: totalIndicationResults,
      },
      strategies: {
        total: strategyConfigs.length,
        enabled: enabledStrategies.length,
        totalPositions: totalStrategyPositions,
      },
    }
  }

  /**
   * Get best performing strategy configs
   */
  async getBestPerformingStrategies(limit: number = 10): Promise<Array<{
    config: StrategyConfig
    stats: any
  }>> {
    const configs = await this.strategyManager.getEnabledConfigs()
    // Fan out the per-config stats reads — each is an independent
    // Redis lookup and the sequential pattern serialised N round-trips
    // on dashboards that frequently call this for the top-N panel.
    const all = await Promise.all(
      configs.map(async (config) => {
        const stats = await this.strategyManager.getStats(config.id)
        return { config, stats }
      }),
    )
    return all
      .filter((r) => r.stats.totalPositions > 0)
      .sort((a, b) => b.stats.winRate - a.stats.winRate)
      .slice(0, limit)
  }
}
