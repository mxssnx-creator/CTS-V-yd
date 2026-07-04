/**
 * Preset Coordination Engine
 * Handles multiple configuration sets with independent position limits
 * Loads historical data only if not exists, calculates missing timeranges
 * Coordinates real position opening based on evaluation results
 */

import { sql, execute, getDatabaseType } from "@/lib/db"
import type { PresetType, PresetConfigurationSet, PresetCoordinationResult } from "@/lib/types-preset-coordination"
import { calculateIndicators, type IndicatorConfig } from "./indicators"
// Plain `crypto` — Edge build aliases this to `false` via `next.config.mjs`.
import * as crypto from "crypto"
import { PresetPseudoPositionManager } from "./preset-pseudo-position-manager"
import { DataSyncManager } from "./data-sync-manager"
import { logProgressionEvent } from "./engine-progression-logs"

export interface PresetCoordinationConfig {
  connectionId: string
  presetTypeId: string
  autoInitiate: boolean
  calculateHistory: boolean
}

export class PresetCoordinationEngine {
  private connectionId: string
  private presetTypeId: string
  private isRunning = false
  private coordinationInterval?: NodeJS.Timeout
  private presetType: PresetType | null = null
  private configurationSets: PresetConfigurationSet[] = []
  private positionLimits: Map<string, number> = new Map()
  private lastPositionTime: Map<string, number> = new Map()
  private pseudoPositionManager: PresetPseudoPositionManager

  private readonly BATCH_SIZE = 10
  // No MAX_CONCURRENT_SYMBOLS — process all symbols in connection dynamically
  // Symbol-level concurrency is controlled by engine-manager.ts SYMBOL_CONCURRENCY=1
  private readonly MAX_CONCURRENT_INDICATIONS = 20 // Process 20 indication combinations in parallel
  private readonly RATE_LIMIT_DELAY = 100

  constructor(connectionId: string, presetTypeId: string) {
    this.connectionId = connectionId
    this.presetTypeId = presetTypeId
    this.pseudoPositionManager = new PresetPseudoPositionManager(connectionId, presetTypeId)
  }

  /**
   * Start the preset coordination engine
   */
  async start(config: PresetCoordinationConfig): Promise<void> {
    if (this.isRunning) {
      console.log("[v0] Preset coordination engine already running")
      return
    }

    console.log("[v0] Starting preset coordination engine")

    try {
      // Load preset type and configuration sets
      await this.loadPresetConfiguration()

      if (config.calculateHistory) {
        // Load historical data for all symbols (only if not exists)
        await this.loadHistoricalDataIfNeeded()
      }

      // Calculate coordination results for all configuration combinations
      await this.calculateCoordinationResults()

      if (config.autoInitiate) {
        // Start coordination interval loop
        await this.startCoordinationLoop()
      }

      await this.pseudoPositionManager.start()

      this.isRunning = true
      console.log("[v0] Preset coordination engine started successfully")
    } catch (error) {
      console.error("[v0] Failed to start preset coordination engine:", error)
      throw error
    }
  }

  /**
   * Stop the preset coordination engine
   */
  async stop(): Promise<void> {
    if (!this.isRunning) return

    console.log("[v0] Stopping preset coordination engine")

    if (this.coordinationInterval) clearInterval(this.coordinationInterval)

    await this.pseudoPositionManager.stop()

    this.isRunning = false
    console.log("[v0] Preset coordination engine stopped")
  }

  /**
   * Load preset type and configuration sets
   */
  private async loadPresetConfiguration(): Promise<void> {
    // Load preset type
    const [presetType] = await sql`
      SELECT * FROM preset_types WHERE id = ${this.presetTypeId}
    `

    if (!presetType) {
      throw new Error(`Preset type ${this.presetTypeId} not found`)
    }

    this.presetType = presetType as PresetType

    // Load configuration sets
    const sets = await sql`
      SELECT cs.* FROM preset_configuration_sets cs
      INNER JOIN preset_type_sets pts ON cs.id = pts.configuration_set_id
      WHERE pts.preset_type_id = ${this.presetTypeId}
        AND pts.is_active = true
        AND cs.is_active = true
      ORDER BY pts.priority ASC
    `

    this.configurationSets = sets as PresetConfigurationSet[]

    console.log(`[v0] Loaded ${this.configurationSets.length} configuration sets`)
  }

  /**
   * Load historical data only if not already exists
   * Calculate only missing timerange
   */
  private async loadHistoricalDataIfNeeded(): Promise<void> {
    console.log("[v0] Checking historical data...")
    const symbolDayRequirements = new Map<string, number>()

    for (const configSet of this.configurationSets) {
      const symbols = await this.getSymbolsForConfigSet(configSet)
      for (const symbol of symbols) {
        const existingDays = symbolDayRequirements.get(symbol) || 0
        symbolDayRequirements.set(symbol, Math.max(existingDays, configSet.range_days))
      }
    }

    const symbolEntries = Array.from(symbolDayRequirements.entries())
    // Process all symbols in the connection without artificial batching limits.
    // SYMBOL_CONCURRENCY=1 in engine-manager ensures sequential CPU scheduling.
    const batches = this.createBatches(symbolEntries, symbolEntries.length || 1)
    let completed = 0

    for (const batch of batches) {
      await Promise.all(
        batch.map(async ([symbol, requiredDays]) => {
          try {
            const endTime = new Date()
            const startTime = new Date(endTime.getTime() - requiredDays * 24 * 60 * 60 * 1000)
            const syncStatus = await DataSyncManager.checkSyncStatus(
              this.connectionId,
              symbol,
              "market_data",
              startTime,
              endTime,
            )

            if (!syncStatus.needsSync) {
              console.log(`[v0] Historical data for ${symbol} already fully synced`)
              completed++
              return
            }

            for (const missingRange of syncStatus.missingRanges) {
              await this.loadHistoricalDataRangeForSymbol(symbol, missingRange.start, missingRange.end)
            }

            completed++
            await logProgressionEvent(this.connectionId, "preset_historical_progress", "info", "Historical sync progress", {
              completed,
              total: symbolEntries.length,
              symbol,
              requiredDays,
              missingRanges: syncStatus.missingRanges.length,
            })
          } catch (error) {
            console.error(`[v0] Failed to check/load historical data for ${symbol}:`, error)
            completed++
          }
        }),
      )

      await new Promise((resolve) => setTimeout(resolve, this.RATE_LIMIT_DELAY))
    }

    console.log("[v0] Historical data check complete")
  }

  /**
   * Load historical data for a symbol (only missing timerange)
   */
  private async loadHistoricalDataRangeForSymbol(symbol: string, startTime: Date, endTime: Date): Promise<void> {
    // Fetch historical OHLCV data from exchange
    // This is a placeholder - actual implementation depends on exchange API
    const historicalData = await this.fetchHistoricalOHLCV(symbol, startTime, endTime)

    // Store in database
    if (historicalData.length > 0) {
      await this.storeHistoricalData(symbol, historicalData)
      await DataSyncManager.logSync(
        this.connectionId,
        symbol,
        "market_data",
        startTime,
        endTime,
        historicalData.length,
        "success",
      )
      console.log(
        `[v0] Loaded ${historicalData.length} candles for ${symbol} [${startTime.toISOString()} → ${endTime.toISOString()}]`,
      )
    } else {
      await DataSyncManager.logSync(this.connectionId, symbol, "market_data", startTime, endTime, 0, "partial")
    }
  }

  /**
   * Calculate coordination results for all configuration combinations
   */
  private async calculateCoordinationResults(): Promise<void> {
    console.log("[v0] Calculating coordination results...")

    // ── Per-config-set fan-out ─────────────────────────────────────────
    // ConfigurationSets are independent — each writes to its own
    // result keyspace — so iterate them in parallel. Within a single
    // configSet we still fan out across symbols with a bounded
    // concurrency cap (MAX_CONCURRENT_SYMBOLS), matching the pattern
    // used in `loadHistoricalDataIfNeeded` above. This turns the
    // previous O(configSets × symbols) sequential chain into a
    // bounded-parallel fan-out that scales with hardware/Redis
    // capacity instead of with the size of the basket.
    await Promise.all(
      this.configurationSets.map(async (configSet) => {
        try {
          const symbols = await this.getSymbolsForConfigSet(configSet)
          // Dynamic batching: no artificial symbol limits, respects SYMBOL_CONCURRENCY=1
          const batches = this.createBatches(symbols, symbols.length || 1)
          for (const batch of batches) {
            await Promise.all(
              batch.map((symbol) =>
                this.calculateConfigSetResults(configSet, symbol).catch((err) => {
                  console.error(
                    `[v0] calculateConfigSetResults failed for set=${configSet.id} symbol=${symbol}:`,
                    err instanceof Error ? err.message : String(err),
                  )
                }),
              ),
            )
          }
        } catch (error) {
          console.error(`[v0] Failed to calculate results for config set ${configSet.id}:`, error)
        }
      }),
    )

    console.log("[v0] Coordination results calculation complete")
  }

  /**
   * Calculate results for a specific configuration set and symbol
   * Now processes indication combinations asynchronously in parallel
   */
  private async calculateConfigSetResults(configSet: PresetConfigurationSet, symbol: string): Promise<void> {
    // Get historical data
    const historicalData = await this.getHistoricalData(symbol, configSet.range_days)

    if (historicalData.length < 100) {
      console.log(`[v0] Insufficient historical data for ${symbol}`)
      return
    }

    // Generate all indication parameter combinations (50% range with dynamic steps)
    const indicationCombinations = this.generateIndicationCombinations(configSet)

    // Generate all position range combinations
    const positionRangeCombinations = this.generatePositionRangeCombinations(configSet)

    // Generate all trailing combinations
    const trailingCombinations = this.generateTrailingCombinations(configSet)

    const allCombinations: Array<{
      indication: any
      position: any
      trailing: any
    }> = []

    for (const indicationParams of indicationCombinations) {
      for (const positionRange of positionRangeCombinations) {
        for (const trailing of trailingCombinations) {
          allCombinations.push({
            indication: indicationParams,
            position: positionRange,
            trailing: trailing,
          })
        }
      }
    }

    console.log(`[v0] Processing ${allCombinations.length} combinations for ${symbol} asynchronously`)

    // Process combinations in parallel batches
    await this.processCombinationsInParallel(configSet, symbol, historicalData, allCombinations)
  }

  /**
   * Process indication combinations in parallel batches for faster execution
   */
  private async processCombinationsInParallel(
    configSet: PresetConfigurationSet,
    symbol: string,
    historicalData: any[],
    combinations: Array<{ indication: any; position: any; trailing: any }>,
  ): Promise<void> {
    const batches = this.createBatches(combinations, this.MAX_CONCURRENT_INDICATIONS)

    for (const batch of batches) {
      // Process batch in parallel
      await Promise.all(
        batch.map(async (combo) => {
          try {
            await this.calculateCombinationResult(
              configSet,
              symbol,
              historicalData,
              combo.indication,
              combo.position,
              combo.trailing,
            )
          } catch (error) {
            console.error(`[v0] Failed to calculate combination for ${symbol}:`, error)
          }
        }),
      )

      // Small delay between batches to avoid overwhelming the system
      await new Promise((resolve) => setTimeout(resolve, this.RATE_LIMIT_DELAY))
    }
  }

  /**
   * Calculate result for a specific combination
   * Now fully async and can run in parallel with other combinations
   */
  private async calculateCombinationResult(
    configSet: PresetConfigurationSet,
    symbol: string,
    historicalData: any[],
    indicationParams: any,
    positionRange: any,
    trailing: any,
  ): Promise<void> {
    // Calculate indicators asynchronously for parallel processing
    const result = await this.calculateIndicatorsAsync(historicalData, configSet, indicationParams)

    // Simulate trades asynchronously for parallel processing
    const trades = await this.simulateTradesAsync(
      historicalData,
      result.signals,
      positionRange.takeprofit,
      positionRange.stoploss,
      trailing.enabled,
      trailing.start,
      trailing.stop,
    )

    // Calculate performance metrics
    const metrics = this.calculatePerformanceMetrics(trades, configSet)

    // Store result
    const paramsHash = this.hashIndicationParams(indicationParams)

    await sql`
      INSERT INTO preset_coordination_results (
        id, preset_type_id, configuration_set_id, symbol,
        indication_type, indication_params,
        takeprofit_factor, stoploss_ratio,
        trailing_enabled, trail_start, trail_stop,
        profit_factor, win_rate, total_trades, winning_trades, losing_trades,
        avg_profit, avg_loss, max_drawdown, drawdown_time_hours,
        profit_factor_last_25, profit_factor_last_50, positions_per_24h,
        is_valid, validation_reason, last_validated_at,
        created_at, updated_at
      ) VALUES (
        ${this.generateId()}, ${this.presetTypeId}, ${configSet.id}, ${symbol},
        ${configSet.indication_type}, ${JSON.stringify(indicationParams)},
        ${positionRange.takeprofit}, ${positionRange.stoploss},
        ${trailing.enabled}, ${trailing.start}, ${trailing.stop},
        ${metrics.profitFactor}, ${metrics.winRate}, ${metrics.totalTrades},
        ${metrics.winningTrades}, ${metrics.losingTrades},
        ${metrics.avgProfit}, ${metrics.avgLoss}, ${metrics.maxDrawdown},
        ${metrics.drawdownTimeHours}, ${metrics.profitFactorLast25},
        ${metrics.profitFactorLast50}, ${metrics.positionsPer24h},
        ${metrics.isValid}, ${metrics.validationReason}, datetime('now'),
        datetime('now'), datetime('now')
      )
      ON CONFLICT (preset_type_id, configuration_set_id, symbol, indication_type, takeprofit_factor, stoploss_ratio, trailing_enabled, trail_start, trail_stop)
      DO UPDATE SET
        profit_factor = ${metrics.profitFactor},
        win_rate = ${metrics.winRate},
        total_trades = ${metrics.totalTrades},
        winning_trades = ${metrics.winningTrades},
        losing_trades = ${metrics.losingTrades},
        avg_profit = ${metrics.avgProfit},
        avg_loss = ${metrics.avgLoss},
        max_drawdown = ${metrics.maxDrawdown},
        drawdown_time_hours = ${metrics.drawdownTimeHours},
        profit_factor_last_25 = ${metrics.profitFactorLast25},
        profit_factor_last_50 = ${metrics.profitFactorLast50},
        positions_per_24h = ${metrics.positionsPer24h},
        is_valid = ${metrics.isValid},
        validation_reason = ${metrics.validationReason},
        last_validated_at = datetime('now'),
        updated_at = datetime('now')
    `

    // Initialize position limit tracking for this configuration
    await this.initializePositionLimit(configSet, symbol, indicationParams, positionRange, trailing, paramsHash)
  }

  /**
   * Calculate indicators asynchronously for parallel processing
   */
  private async calculateIndicatorsAsync(
    historicalData: any[],
    configSet: PresetConfigurationSet,
    indicationParams: any,
  ): Promise<{ signals: any[] }> {
    return new Promise((resolve) => {
      // Wrap synchronous calculation in Promise for async execution
      setImmediate(() => {
        const prices = historicalData.map((d) => d.close)
        const indicatorConfig: IndicatorConfig = {
          type: configSet.indication_type as
            | "rsi"
            | "macd"
            | "bollinger"
            | "sar"
            | "ema"
            | "sma"
            | "stochastic"
            | "adx",
          params: indicationParams,
        }

        const signals = calculateIndicators(prices, [indicatorConfig])
        resolve({ signals })
      })
    })
  }

  /**
   * Simulate trades asynchronously for parallel processing
   */
  private async simulateTradesAsync(
    historicalData: any[],
    signals: any[],
    tpFactor: number,
    slRatio: number,
    trailingEnabled: boolean,
    trailStart: number | null,
    trailStop: number | null,
  ): Promise<any[]> {
    return new Promise((resolve) => {
      // Wrap synchronous simulation in Promise for async execution
      setImmediate(() => {
        const trades = this.simulateTrades(
          historicalData,
          signals,
          tpFactor,
          slRatio,
          trailingEnabled,
          trailStart,
          trailStop,
        )
        resolve(trades)
      })
    })
  }

  /**
   * Start coordination loop for real trading
   */
  private async startCoordinationLoop(): Promise<void> {
    if (!this.presetType) return

    const intervalMs = this.presetType.evaluation_interval_hours * 60 * 60 * 1000

    this.coordinationInterval = setInterval(async () => {
      try {
        await this.processCoordinationCycle()
      } catch (error) {
        console.error("[v0] Coordination cycle error:", error)
      }
    }, intervalMs)

    // Run first cycle immediately
    await this.processCoordinationCycle()
  }

  /**
   * Process coordination cycle - check valid configurations and open positions
   * Now processes results asynchronously in parallel
   */
  private async processCoordinationCycle(): Promise<void> {
    console.log("[v0] Processing coordination cycle...")

    // Get all valid coordination results
    const validResults = await sql`
      SELECT * FROM preset_coordination_results
      WHERE preset_type_id = ${this.presetTypeId}
        AND is_valid = 1
      ORDER BY profit_factor_last_25 DESC, profit_factor_last_50 DESC
    `

    const batches = this.createBatches(validResults, this.MAX_CONCURRENT_INDICATIONS)

    for (const batch of batches) {
      await Promise.all(
        batch.map(async (result) => {
          try {
            await this.evaluateAndOpenPosition(result as PresetCoordinationResult)
          } catch (error) {
            console.error(`[v0] Failed to evaluate result ${(result as PresetCoordinationResult).id}:`, error)
          }
        }),
      )

      // Small delay between batches
      await new Promise((resolve) => setTimeout(resolve, this.RATE_LIMIT_DELAY))
    }

    console.log("[v0] Coordination cycle complete")
  }

  /**
   * Evaluate coordination result and open position if conditions met
   * Now uses separate pseudo position manager
   */
  private async evaluateAndOpenPosition(result: PresetCoordinationResult): Promise<void> {
    if (!this.presetType) return

    // Check if last 25 or 50 positions are profitable
    const isLast25Profitable = result.profit_factor_last_25 > 0
    const isLast50Profitable = result.profit_factor_last_50 > 0

    if (!isLast25Profitable && !isLast50Profitable) {
      return // Skip if not profitable in recent positions
    }

    // Get current market signal
    const currentSignal = await this.getCurrentMarketSignal(result)

    if (!currentSignal || currentSignal.direction === "neutral") {
      return
    }

    // Check position limits
    const canOpen = await this.checkPositionLimit(result, currentSignal.direction)

    if (!canOpen) {
      return
    }

    // Check timeout
    const lastPositionKey = `${result.symbol}-${result.indication_type}-${currentSignal.direction}`
    const lastPositionTime = this.lastPositionTime.get(lastPositionKey) || 0
    const timeSinceLastPosition = Date.now() - lastPositionTime

    if (timeSinceLastPosition < this.presetType!.timeout_after_position * 1000) {
      return
    }

    // Get current price
    const currentPrice = await this.getCurrentPrice(result.symbol)

    const positionId = await this.pseudoPositionManager.createPseudoPosition(result, currentSignal, currentPrice)

    if (positionId) {
      // Update position limit and cooldown
      await this.updatePositionLimit(result, currentSignal.direction, 1)
      this.lastPositionTime.set(lastPositionKey, Date.now())

      console.log(`[v0] Created pseudo position ${positionId} for ${result.symbol} (${currentSignal.direction})`)
    }
  }

  /**
   * Check if position can be opened for this configuration + direction
   */
  private async checkPositionLimit(result: PresetCoordinationResult, direction: string): Promise<boolean> {
    const paramsHash = this.hashIndicationParams(result.indication_params)

    const [limit] = await sql`
      SELECT * FROM preset_position_limits
      WHERE preset_type_id = ${this.presetTypeId}
        AND configuration_set_id = ${result.configuration_set_id}
        AND symbol = ${result.symbol}
        AND indication_params_hash = ${paramsHash}
        AND takeprofit_factor = ${result.takeprofit_factor}
        AND stoploss_ratio = ${result.stoploss_ratio}
        AND direction = ${direction}
        AND trailing_enabled = ${result.trailing_enabled}
        AND trail_start = ${result.trail_start}
        AND trail_stop = ${result.trail_stop}
    `

    if (!limit) return false

    // Check if under limit
    if (limit.current_positions >= limit.max_positions) {
      return false
    }

    // Check cooldown
    if (limit.cooldown_until && new Date(limit.cooldown_until) > new Date()) {
      return false
    }

    return true
  }

  /**
   * Update position limit after opening position
   */
  private async updatePositionLimit(
    result: PresetCoordinationResult,
    direction: string,
    change: number,
  ): Promise<void> {
    const paramsHash = this.hashIndicationParams(result.indication_params)

    await sql`
      UPDATE preset_position_limits
      SET current_positions = current_positions + ${change},
          last_position_opened_at = CURRENT_TIMESTAMP,
          updated_at = CURRENT_TIMESTAMP
      WHERE preset_type_id = ${this.presetTypeId}
        AND configuration_set_id = ${result.configuration_set_id}
        AND symbol = ${result.symbol}
        AND indication_params_hash = ${paramsHash}
        AND takeprofit_factor = ${result.takeprofit_factor}
        AND stoploss_ratio = ${result.stoploss_ratio}
        AND direction = ${direction}
        AND trailing_enabled = ${result.trailing_enabled}
        AND trail_start = ${result.trail_start}
        AND trail_stop = ${result.trail_stop}
    `
  }

  /**
   * Initialize position limit tracking for a specific configuration combination
   * Creates separate limits for long and short directions
   */
  private async initializePositionLimit(
    configSet: PresetConfigurationSet,
    symbol: string,
    indicationParams: any,
    positionRange: any,
    trailing: any,
    paramsHash: string,
  ): Promise<void> {
    if (!this.presetType) return

    const maxPositions = this.presetType.max_positions_per_range || 250

    // Initialize for both long and short directions
    for (const direction of ["long", "short"]) {
      await sql`
        INSERT INTO preset_position_limits (
          id, preset_type_id, configuration_set_id, symbol,
          indication_params_hash, takeprofit_factor, stoploss_ratio,
          direction, trailing_enabled, trail_start, trail_stop,
          max_positions, current_positions,
          created_at, updated_at
        ) VALUES (
          ${this.generateId()}, ${this.presetTypeId}, ${configSet.id}, ${symbol},
          ${paramsHash}, ${positionRange.takeprofit}, ${positionRange.stoploss},
          ${direction}, ${trailing.enabled}, ${trailing.start}, ${trailing.stop},
          ${maxPositions}, 0,
          datetime('now'), datetime('now')
        )
        ON CONFLICT (
          preset_type_id, configuration_set_id, symbol, indication_params_hash,
          takeprofit_factor, stoploss_ratio, direction, trailing_enabled, trail_start, trail_stop
        ) DO UPDATE SET
          max_positions = ${maxPositions},
          updated_at = datetime('now')
      `
    }
  }

  /**
   * Open real position on exchange
   */
  private async openRealPosition(result: PresetCoordinationResult, signal: any): Promise<void> {
    // Get current price
    const currentPrice = await this.getCurrentPrice(result.symbol)

    // Calculate position size based on configuration
    const positionSize = 100 // Default, should be configurable

    // Store real trade record
    await sql`
      INSERT INTO preset_real_trades (
        id, connection_id, preset_type_id, configuration_set_id,
        coordination_result_id, symbol, direction,
        entry_price, quantity, leverage,
        indication_type, takeprofit_factor, stoploss_ratio,
        trailing_enabled, trail_start, trail_stop,
        status, opened_at, created_at
      ) VALUES (
        ${this.generateId()}, ${this.connectionId}, ${this.presetTypeId},
        ${result.configuration_set_id}, ${result.id},
        ${result.symbol}, ${signal.direction},
        ${currentPrice}, ${positionSize}, 1,
        ${result.indication_type}, ${result.takeprofit_factor}, ${result.stoploss_ratio},
        ${result.trailing_enabled}, ${result.trail_start}, ${result.trail_stop},
        'open', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
      )
    `

    try {
      // Get connection settings to check if live trading is enabled
      const [connection] = await sql<any>`
        SELECT * FROM connections WHERE id = ${this.connectionId}
      `

      if (connection?.is_live_trade || connection?.is_preset_trade) {
        const { createExchangeAPI } = await import("@/lib/exchanges")
        const exchangeAPI = createExchangeAPI({
          id: connection.id,
          name: connection.name,
          exchange: connection.exchange,
          apiKey: connection.api_key,
          apiSecret: connection.api_secret,
          testnet: connection.is_testnet ?? false,
          status: "connected",
          connectionMethod: connection.connection_method || "rest",
        })

        // Calculate TP and SL prices
        const isLong = signal.direction === "long"
        const tpPrice = isLong
          ? currentPrice * (1 + result.takeprofit_factor / 100)
          : currentPrice * (1 - result.takeprofit_factor / 100)
        const slPrice = isLong
          ? currentPrice * (1 - result.stoploss_ratio / 100)
          : currentPrice * (1 + result.stoploss_ratio / 100)

        const orderResult = await exchangeAPI.placeOrder({
          symbol: result.symbol,
          side: isLong ? "buy" : "sell",
          type: "market",
          quantity: positionSize,
          leverage: 1,
          takeProfit: tpPrice,
          stopLoss: slPrice,
        })

        console.log(`[v0] Exchange order placed: ${orderResult.orderId}`)

        // Mirror to exchange position manager for tracking
        const { ExchangePositionManager } = await import("@/lib/exchange-position-manager")
        const positionManager = new ExchangePositionManager(this.connectionId)

        await positionManager.mirrorToExchange({
          connectionId: this.connectionId,
          realPseudoPositionId: result.id,
          exchangeId: orderResult.orderId,
          symbol: result.symbol,
          side: signal.direction,
          entryPrice: currentPrice,
          quantity: positionSize,
          volumeUsd: positionSize * currentPrice,
          leverage: 1,
          takeprofit: tpPrice,
          stoploss: slPrice,
          trailingEnabled: result.trailing_enabled,
          trailStart: result.trail_start ?? undefined,
          trailStop: result.trail_stop ?? undefined,
          tradeMode: "preset",
          indicationType: result.indication_type,
        })
      }
    } catch (error) {
      console.error("[v0] Failed to open position on exchange:", error)
      // Continue - the pseudo position is still tracked
    }
  }

  // ============ HELPER METHODS ============

  private async getSymbolsForConfigSet(configSet: PresetConfigurationSet): Promise<string[]> {
    switch (configSet.symbol_mode) {
      case "main":
        return ["BTCUSDT", "ETHUSDT", "BNBUSDT"] // Default main symbols
      case "forced":
        return configSet.symbols || []
      case "manual":
        return configSet.symbols || []
      case "exchange":
        return await this.getTopSymbolsByExchange(configSet)
      default:
        return []
    }
  }

  private async getTopSymbolsByExchange(configSet: PresetConfigurationSet): Promise<string[]> {
    // Fetch top symbols from exchange based on order_by criteria
    // This is a placeholder - actual implementation depends on exchange API
    return ["BTCUSDT", "ETHUSDT", "SOLUSDT"]
  }

  private generateIndicationCombinations(configSet: PresetConfigurationSet): any[] {
    // Generate parameter combinations with 50% range and dynamic steps
    const combinations: any[] = []
    const baseParams = configSet.indication_params

    // For each parameter, generate range (50% difference)
    for (const [key, value] of Object.entries(baseParams)) {
      if (typeof value === "number") {
        const min = Math.floor(value * 0.5) // 50% below
        const max = Math.ceil(value * 1.5) // 50% above
        const step = Math.floor((max - min) / 10) || 1 // Dynamic step based on range

        for (let v = min; v <= max; v += step) {
          combinations.push({ ...baseParams, [key]: v })
        }
      }
    }

    return combinations.length > 0 ? combinations : [baseParams]
  }

  private generatePositionRangeCombinations(configSet: PresetConfigurationSet): any[] {
    const combinations: any[] = []

    for (let tp = configSet.takeprofit_min; tp <= configSet.takeprofit_max; tp += configSet.takeprofit_step) {
      for (let sl = configSet.stoploss_min; sl <= configSet.stoploss_max; sl += configSet.stoploss_step) {
        combinations.push({ takeprofit: tp, stoploss: sl })
      }
    }

    return combinations
  }

  private generateTrailingCombinations(configSet: PresetConfigurationSet): any[] {
    const combinations: any[] = []

    // Without trailing
    combinations.push({ enabled: false, start: null, stop: null })

    // With trailing (if enabled)
    if (configSet.trailing_enabled) {
      for (const start of configSet.trail_starts) {
        for (const stop of configSet.trail_stops) {
          combinations.push({ enabled: true, start, stop })
        }
      }
    }

    return combinations
  }

  private simulateTrades(
    historicalData: any[],
    signals: any[],
    tpFactor: number,
    slRatio: number,
    trailingEnabled: boolean,
    trailStart: number | null,
    trailStop: number | null,
  ): any[] {
    // Simulate trades based on signals and exit conditions
    // This is a simplified simulation - actual implementation would be more complex
    return []
  }

  private calculatePerformanceMetrics(trades: any[], configSet: PresetConfigurationSet): any {
    // Calculate performance metrics from simulated trades
    const totalTrades = trades.length
    const winningTrades = trades.filter((t: any) => t.profit > 0).length
    const losingTrades = totalTrades - winningTrades
    const winRate = totalTrades > 0 ? winningTrades / totalTrades : 0

    const totalProfit = trades.reduce((sum: number, t: any) => sum + Math.max(0, t.profit), 0)
    const totalLoss = Math.abs(trades.reduce((sum: number, t: any) => sum + Math.min(0, t.profit), 0))
    const profitFactor = totalLoss > 0 ? totalProfit / totalLoss : 0

    const avgProfit = winningTrades > 0 ? totalProfit / winningTrades : 0
    const avgLoss = losingTrades > 0 ? totalLoss / losingTrades : 0

    // Calculate last 25 and 50 positions profit factor
    const last25 = trades.slice(-25)
    const last50 = trades.slice(-50)

    const profitFactorLast25 = this.calculateProfitFactorForTrades(last25)
    const profitFactorLast50 = this.calculateProfitFactorForTrades(last50)

    // Calculate positions per 24h
    const timeSpan =
      trades.length > 0 ? (trades[trades.length - 1].timestamp - trades[0].timestamp) / (1000 * 60 * 60) : 1
    const positionsPer24h = (totalTrades / timeSpan) * 24

    // Validation
    const isValid =
      profitFactor >= configSet.profit_factor_min &&
      totalTrades >= configSet.trades_per_48h_min &&
      (profitFactorLast25 > 0 || profitFactorLast50 > 0)

    const validationReason = !isValid
      ? `Profit factor: ${profitFactor.toFixed(2)}, Trades: ${totalTrades}, Last 25 PF: ${profitFactorLast25.toFixed(2)}`
      : "Valid"

    const drawdownMetrics = this.calculateDrawdownMetrics(trades)

    return {
      profitFactor,
      winRate,
      totalTrades,
      winningTrades,
      losingTrades,
      avgProfit,
      avgLoss,
      maxDrawdown: drawdownMetrics.maxDrawdown,
      drawdownTimeHours: drawdownMetrics.maxDrawdownDuration,
      profitFactorLast25,
      profitFactorLast50,
      positionsPer24h,
      isValid,
      validationReason,
    }
  }

  private calculateDrawdownMetrics(trades: any[]): { maxDrawdown: number; maxDrawdownDuration: number } {
    if (trades.length === 0) {
      return { maxDrawdown: 0, maxDrawdownDuration: 0 }
    }

    const sortedTrades = [...trades].sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime())

    let cumulativePnL = 0
    let peak = 0
    let maxDrawdown = 0
    let currentDrawdownStart: Date | null = null
    let maxDrawdownDuration = 0

    for (const trade of sortedTrades) {
      cumulativePnL += trade.profit

      if (cumulativePnL > peak) {
        peak = cumulativePnL
        currentDrawdownStart = null
      } else if (cumulativePnL < peak && peak > 0) {
        if (!currentDrawdownStart) {
          currentDrawdownStart = new Date(trade.timestamp)
        }
        const currentDrawdown = ((peak - cumulativePnL) / peak) * 100
        if (currentDrawdown > maxDrawdown) {
          maxDrawdown = currentDrawdown
        }
      }
    }

    if (currentDrawdownStart && sortedTrades.length > 0) {
      const lastTradeTime = new Date(sortedTrades[sortedTrades.length - 1].timestamp).getTime()
      const duration = (lastTradeTime - currentDrawdownStart.getTime()) / (1000 * 60 * 60)
      if (duration > maxDrawdownDuration) {
        maxDrawdownDuration = duration
      }
    }

    return { maxDrawdown, maxDrawdownDuration }
  }

  private calculateProfitFactorForTrades(trades: any[]): number {
    if (trades.length === 0) return 0

    const totalProfit = trades.reduce((sum: number, t: any) => sum + Math.max(0, t.profit), 0)
    const totalLoss = Math.abs(trades.reduce((sum: number, t: any) => sum + Math.min(0, t.profit), 0))

    return totalLoss > 0 ? totalProfit / totalLoss : 0
  }

  private hashIndicationParams(params: any): string {
    return crypto.createHash("sha256").update(JSON.stringify(params)).digest("hex")
  }

  private async getHistoricalData(symbol: string, days: number): Promise<any[]> {
    const result = await sql`
      SELECT * FROM preset_historical_data
      WHERE connection_id = ${this.connectionId}
        AND symbol = ${symbol}
        AND timestamp > NOW() - INTERVAL '${days} days'
      ORDER BY timestamp ASC
    `
    return result
  }

  private async getCurrentMarketSignal(result: PresetCoordinationResult): Promise<any> {
    // Get current market data and calculate signal
    // This is a placeholder - actual implementation would calculate real-time indicators
    return { direction: "long", strength: 0.8 }
  }

  private async getCurrentPrice(symbol: string): Promise<number> {
    const [result] = await sql<any>`
      SELECT price FROM market_data
      WHERE connection_id = ${this.connectionId}
        AND symbol = ${symbol}
      ORDER BY timestamp DESC
      LIMIT 1
    `
    return result?.price || 0
  }

  private async fetchHistoricalOHLCV(symbol: string, startTime: Date, endTime: Date): Promise<any[]> {
    // Fetch historical OHLCV data from exchange
    // This is a placeholder - actual implementation depends on exchange API
    return []
  }

  private async storeHistoricalData(symbol: string, data: any[]): Promise<void> {
    if (data.length === 0) return

    // Batch insert historical data using SQLite
    const batches = this.createBatches(data, 100)
    const dbType = getDatabaseType()

    for (const batch of batches) {
      // Build INSERT statement with multiple VALUES
      let placeholders = ""

      if (dbType === "sqlite") {
        placeholders = batch.map(() => "(?, ?, ?, ?, ?, ?, ?, ?, ?)").join(", ")
      } else {
        // For PostgreSQL, use $1, $2, etc.
        let paramIdx = 1
        placeholders = batch
          .map(() => {
            const rowPlaceholders = []
            for (let i = 0; i < 9; i++) {
              rowPlaceholders.push(`$${paramIdx++}`)
            }
            return `(${rowPlaceholders.join(", ")})`
          })
          .join(", ")
      }

      const values: any[] = []
      for (const d of batch) {
        values.push(this.generateId(), this.connectionId, symbol, d.open, d.high, d.low, d.close, d.volume, d.timestamp)
      }

      const query = `
        INSERT INTO preset_historical_data (
          id, connection_id, symbol, open, high, low, close, volume, timestamp
        ) VALUES ${placeholders}
        ON CONFLICT (connection_id, symbol, timestamp) DO NOTHING
      `

      try {
        await execute(query, values)
      } catch (error) {
        console.error("[v0] Failed to insert historical data batch:", error)
      }
    }
  }

  private createBatches<T>(items: T[], batchSize: number): T[][] {
    const batches: T[][] = []
    for (let i = 0; i < items.length; i += batchSize) {
      batches.push(items.slice(i, i + batchSize))
    }
    return batches
  }

  private generateId(): string {
    return `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`
  }
}

interface IndicatorSignal {
  type: string
  strength: number
  direction: "long" | "short" | "neutral"
  value: number
  timestamp: Date
}
