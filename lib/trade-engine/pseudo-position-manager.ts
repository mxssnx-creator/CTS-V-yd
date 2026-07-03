/**
 * Pseudo Position Manager
 * Manages pseudo positions (paper trading) with volume calculations
 * NOW: 100% Redis-backed, no SQL
 */

import { getRedisClient, getAppSettings, getSettings, getSettingsVersionCachedSync, createPosition as redisCreatePosition } from "@/lib/redis-db"
import { VolumeCalculator } from "@/lib/volume-calculator"
import { resolveStopLossPercent } from "@/lib/tp-sl-ratio"
import { emitPositionUpdate } from "@/lib/broadcast-helpers"
import { StrategyConfigManager, type PseudoPosition as StrategyPseudoPosition } from "@/lib/strategy-config-manager"
import { calculatePseudoClosePnl, PSEUDO_POSITION_CLOSE_COST_RATIO } from "@/lib/pseudo-position-costs"

/**
 * Cryptographically-strong short ID generator.
 * Uses crypto.getRandomValues (Web Crypto, available Node 18+ globally) so
 * each character carries ~5.17 bits of entropy (36-char alphabet).
 * 12-char default → ~62 bits total — zero collision risk at any realistic
 * position-creation rate. Exported so live-stage.ts and strategy-coordinator.ts
 * share the same canonical source instead of each having a Math.random variant.
 */
export function nanoid(len = 12): string {
  const chars = "abcdefghijklmnopqrstuvwxyz0123456789"
  const bytes = new Uint8Array(len)
  crypto.getRandomValues(bytes)
  let id = ""
  for (let i = 0; i < len; i++) id += chars[bytes[i] % chars.length]
  return id
}

export class PseudoPositionManager {
  private connectionId: string
  private activePositionsCache: any[] | null = null
  private cacheTimestamp = 0
  private readonly CACHE_TTL_MS = 1000 // 1 second cache

  // ── Hot-path write elision ─────────────────────────────────────────
  // Per-position last-written price. The realtime tick compares the
  // incoming market price against this memo before issuing an HSET, so
  // sub-epsilon ticks on quiet symbols produce zero Redis writes. Entry
  // is cleared on close via invalidatePriceMemo() so a reopened id with
  // the same position key starts fresh. FIFO-capped at MAX_PRICE_MEMO
  // so a leaked position id (e.g. close signal lost mid-transaction)
  // cannot grow the map unboundedly over a long-running engine.
  private static readonly MAX_PRICE_MEMO = 1000
  private lastWrittenPrice: Map<string, number> = new Map()

  constructor(connectionId: string) {
    this.connectionId = connectionId
  }

  // ── helpers ──────────────────────────────────────────────────────────

  /** Redis set key that indexes every OPEN position id for this connection */
  private positionsSetKey(): string {
    return `pseudo_positions:${this.connectionId}`
  }

  /**
   * Redis set key that indexes position ids that have been CLOSED.
   * Separate from positionsSetKey() which only tracks open positions.
   * Used by getPositionContext() to read the closed-only window for
   * Main-stage variant gating (prevLosses, lastWins/Losses, prevPosCount).
   * Capped to CLOSED_INDEX_CAP newest entries via ltrim so it never
   * grows unboundedly. TTL reset on each write.
   */
  private closedPositionsIndexKey(): string {
    return `pseudo_positions:${this.connectionId}:closed_index`
  }
  private static readonly CLOSED_INDEX_CAP = 200
  private static readonly CLOSED_INDEX_TTL = 7 * 24 * 60 * 60 // 7 days

  /**
   * Redis set key that indexes all currently-active configSetKeys for O(1) duplicate detection.
   * Each active position's configSetKey is added on creation and removed on close.
   */
  private activeConfigKeysSetKey(): string {
    return `pseudo_positions:${this.connectionId}:active_config_keys`
  }

  /**
   * Direction-indexed Redis sets for P0-4 max-1-per-direction enforcement.
   * Populated alongside `activeConfigKeysSetKey` on create/close so the
   * per-direction count is O(1) via `scard` without having to enumerate
   * every active position's hash.
   */
  private activeByDirectionKey(side: "long" | "short"): string {
    return `pseudo_positions:${this.connectionId}:active_by_direction:${side}`
  }

  // ── Per-direction cap cache (P0-4) ──────────────────────────────────
  // The operator-tunable cap (Settings → Strategy → Base →
  // `maxActiveBasePseudoPositionsPerDirection`) is cached in-process so
  // `createPosition` doesn't round-trip to Redis on every call, but the
  // cache is version-aware: it invalidates whenever the global
  // `settings_version` counter advances (which happens on every save
  // via `setAppSettings` / `bumpSettingsVersion`). This guarantees a
  // settings change takes effect on the next `createPosition` call
  // within ~250 ms (the version-snapshot TTL) without an engine restart.
  //
  // Default value of 1 matches the spec default. A 30 s hard-refresh
  // deadline covers the edge case where a bump signal is lost.
  private static directionCapCache: { value: number; ts: number; version: number } | null = null
  private static readonly DIRECTION_CAP_HARD_REFRESH_MS = 30_000
  private static readonly DEFAULT_DIRECTION_CAP = 1

  private async getMaxActivePerDirection(): Promise<number> {
    const now = Date.now()
    const liveVersion = getSettingsVersionCachedSync()
    const cached = PseudoPositionManager.directionCapCache
    if (
      cached &&
      cached.version === liveVersion &&
      now - cached.ts < PseudoPositionManager.DIRECTION_CAP_HARD_REFRESH_MS
    ) {
      return cached.value
    }
    try {
      // Use the mirror-aware app-settings reader so the operator's saved
      // value applies whether it was written to the canonical
      // (`app_settings`) or legacy (`all_settings`) hash.
      const s = await getAppSettings()
      const raw = s.maxActiveBasePseudoPositionsPerDirection
      const parsed = Number(raw)
      const value =
        Number.isFinite(parsed) && parsed >= 1
          ? Math.floor(parsed)
          : PseudoPositionManager.DEFAULT_DIRECTION_CAP
      PseudoPositionManager.directionCapCache = { value, ts: now, version: liveVersion }
      return value
    } catch {
      // Fail-safe — cap to the spec default so we never exceed 1 on a
      // transient Redis error rather than silently uncapping.
      return PseudoPositionManager.DEFAULT_DIRECTION_CAP
    }
  }

  /** Redis hash key for one position */
  private positionKey(id: string): string {
    return `pseudo_position:${this.connectionId}:${id}`
  }

  /** Read a single position hash from Redis */
  private async readPosition(id: string): Promise<any | null> {
    try {
      const client = getRedisClient()
      const data = await client.hgetall(this.positionKey(id))
      if (!data || Object.keys(data).length === 0) return null
      return { ...data, id }
    } catch {
      return null
    }
  }

  /**
   * List all positions for this connection, optionally filtered.
   *
   * PERFORMANCE: The previous implementation awaited `readPosition(id)` once
   * per id — one Redis round-trip per position. With dozens of active
   * pseudo positions this ran serially on every realtime tick (1/sec per
   * engine), easily dominating cycle time. We now fan-out all reads in a
   * single `Promise.all` so the whole list is fetched in one RTT window and
   * filtering happens after in O(N) on the already-materialised array.
   */
  private async listPositions(filter?: { status?: string; side?: string; symbol?: string; indicationType?: string }): Promise<any[]> {
    try {
      const client = getRedisClient()
      const ids = await client.smembers(this.positionsSetKey())
      if (!ids || ids.length === 0) return []

      // Pipelined fan-in: queue one HGETALL per id into a single multi()
      // and `exec()` them in one round trip. Prior implementation issued
      // `Promise.all(readPosition(id))` which, against any networked Redis
      // client (Upstash / ioredis / node-redis), is N individual commands
      // on N sockets — the exact latency cliff we're trying to avoid on
      // the 100ms realtime tick. Against the in-memory `InlineLocalRedis`
      // shim this collapses to the same microseconds, so no regression.
      const pipeline = client.multi()
      for (const id of ids) pipeline.hgetall(this.positionKey(id))
      const results = await pipeline.exec()

      const raw: any[] = []
      for (let i = 0; i < ids.length; i++) {
        const r = results?.[i]
        if (!r || r instanceof Error) continue
        // Normalise across upstash (returns the value directly) vs ioredis
        // (returns `[err, value]` tuples). Both shapes resolve to the hash
        // object we want.
        const data = Array.isArray(r) ? r[1] : r
        if (!data || typeof data !== "object" || Object.keys(data).length === 0) continue
        raw.push({ ...data, id: ids[i] })
      }

      const hasFilter = Boolean(
        filter?.status || filter?.side || filter?.symbol || filter?.indicationType,
      )
      if (!hasFilter) return raw

      const positions: any[] = []
      for (const pos of raw) {
        if (filter?.status && pos.status !== filter.status) continue
        if (filter?.side && pos.side !== filter.side) continue
        if (filter?.symbol && pos.symbol !== filter.symbol) continue
        if (filter?.indicationType && pos.indication_type !== filter.indicationType) continue
        positions.push(pos)
      }
      return positions
    } catch (error) {
      console.error("[v0] [PseudoPosMgr] Failed to list positions:", error)
      return []
    }
  }

  // ── public API ────────────────────────────────────────────────────────

  /**
   * Create new pseudo position with proper volume calculation.
   * configSetKey identifies the unique config combination (indType:dir:tp:sl:trailing:size:lev:state).
   * Exactly one active position is allowed per configSetKey.
   */
  async createPosition(params: {
    symbol: string
    indicationType: string
    side: "long" | "short"
    entryPrice: number
    takeprofitFactor: number
    stoplossRatio: number
    profitFactor: number
    effectiveProfitFactor?: number
    trailingEnabled: boolean
    configSetKey?: string  // unique fingerprint of the config combination
    strategyConfigId?: string  // StrategyConfig.id (DB primary key) — optional link into the historic-fill Set keyspace
    /**
     * Multi-step trailing — when present, forces `trailingEnabled = true`
     * and switches `realtime-processor.updateTrailingStop` to the 2-phase
     * state machine (activation gate + ratchet step). All three are
     * RATIOS where 0.1 ≡ 10 % of price.
     *
     * Set by `lib/strategy-coordinator.ts` from the per-Set
     * `trailingProfile` produced by the Settings → Strategy → Trailing
     * matrix. When absent, the legacy single-step path runs.
     */
    trailingStartRatio?: number
    trailingStopRatio?: number
    trailingStepRatio?: number
  }): Promise<string | null> {
    try {
      // Multi-step path forces trailing on regardless of caller flag —
      // the operator opted into the matrix so the position MUST honour it.
      const hasTrailingProfile =
        Number.isFinite(params.trailingStartRatio) &&
        Number.isFinite(params.trailingStopRatio) &&
        Number.isFinite(params.trailingStepRatio) &&
        (params.trailingStartRatio as number) > 0 &&
        (params.trailingStopRatio as number) > 0
      const effectiveTrailing = hasTrailingProfile ? true : params.trailingEnabled

      // Build a canonical config set key if not provided. Including the
      // trailing tuple makes each multi-step variant occupy its own
      // uniqueness slot — distinct (start, stop) combos are NOT collapsed
      // even when TP/SL/side match.
      const configSetKey = params.configSetKey || [
        params.indicationType,
        params.side,
        params.takeprofitFactor.toFixed(4),
        params.stoplossRatio.toFixed(4),
        effectiveTrailing ? "1" : "0",
        ...(hasTrailingProfile
          ? [
              `s${(params.trailingStartRatio as number).toFixed(2)}`,
              `k${(params.trailingStopRatio as number).toFixed(2)}`,
            ]
          : []),
      ].join(":")

      // P0-4: Gate on both Set-uniqueness AND the per-direction cap.
      const canCreate = await this.canCreatePosition(
        params.symbol,
        configSetKey,
        params.side,
      )

      if (!canCreate) {
        return null  // silent — one position per config set is expected, or direction cap reached
      }

      // ── Volume calculation ──────────────────────────────────────────
      const volumeCalc = await (async () => {
        const settings = (await getAppSettings()) || {}
        const positionCostPercent = parseFloat(
          String(settings.exchangePositionCost ?? settings.positionCost ?? "0.02")
        )
        const positionCost =
          (Number.isFinite(positionCostPercent) && positionCostPercent > 0
            ? Math.max(0.02, Math.min(1.0, positionCostPercent))
            : 0.02) / 100
        const positionsAverage = (() => {
          const raw = parseFloat(String(settings.positions_average ?? "2"))
          return Number.isFinite(raw) && raw > 0 ? raw : 2
        })()
        // Operator policy: always max leverage — resolved from the exchange
        // predefinition rather than a stored preference flag.
        const { getMaxLeverageForExchange: _getMaxLev } = await import("@/lib/leverage-policy")
        const { getConnection: _getConn } = await import("@/lib/redis-db")
        const _conn = await _getConn(this.connectionId).catch(() => null)
        const rawLeverage = _getMaxLev(_conn?.exchange)
        const { accountBalance, maxLeverage } =
          await VolumeCalculator.resolveBalanceAndLeverage(this.connectionId, rawLeverage)
        const tradingPair = await getSettings(`trading_pair:${params.symbol}`)
        const exchangeMinVolume = tradingPair?.min_order_size
          ? parseFloat(tradingPair.min_order_size)
          : undefined
        return VolumeCalculator.calculatePositionVolume({
          positionCost,
          positionsAverage,
          accountBalance,
          currentPrice: params.entryPrice,
          leverage: maxLeverage,
          exchangeMinVolume,
        })
      })()

      if (!volumeCalc.finalVolume || volumeCalc.finalVolume <= 0) {
        console.warn(
          `[v0] Cannot create position for ${params.symbol}: ` +
          `volume too small (${volumeCalc.finalVolume}) - ${volumeCalc.adjustmentReason || 'below minimum'}`
        )
        return null
      }

      // Calculate take profit and stop loss prices
      const takeProfitPrice =
        params.side === "long"
          ? params.entryPrice * (1 + params.takeprofitFactor / 100)
          : params.entryPrice * (1 - params.takeprofitFactor / 100)

      const stopLossPercent = resolveStopLossPercent(params.takeprofitFactor, params.stoplossRatio)
      const stopLossPrice =
        params.side === "long"
          ? params.entryPrice * (1 - stopLossPercent / 100)
          : params.entryPrice * (1 + stopLossPercent / 100)

      // Calculate position cost
      const positionCost = (volumeCalc.finalVolume * params.entryPrice) / volumeCalc.leverage

      // Store position in Redis
      const id = nanoid()
      // Generate unique tracking ID to identify system-created positions
      const systemTrackingId = `sys-${this.connectionId}-${nanoid(8)}`
      const client = getRedisClient()

      const positionData: Record<string, string> = {
        connection_id: this.connectionId,
        symbol: params.symbol,
        indication_type: params.indicationType,
        side: params.side,
        config_set_key: configSetKey,
        // Optional explicit link to the historic-fill Set namespace
        // (`strategy:{connId}:config:{strategy_config_id}:positions`).
        // When present, `closePosition` writes the closed row into that
        // list so historic-backfilled Sets stay continuously current.
        // When absent, `closePosition` falls back to parsing `config_set_key`.
        strategy_config_id: params.strategyConfigId || "",
        // System tracking ID — marks this as a system-created position
        system_tracking_id: systemTrackingId,
        entry_price: String(params.entryPrice),
        current_price: String(params.entryPrice),
        quantity: String(volumeCalc.finalVolume),
        position_cost: String(positionCost),
        takeprofit_factor: String(params.takeprofitFactor),
        takeprofit_price: String(takeProfitPrice),
        stoploss_ratio: String(params.stoplossRatio),
        stoploss_price: String(stopLossPrice),
        profit_factor: String(params.profitFactor),
        effective_profit_factor: String(params.effectiveProfitFactor ?? params.profitFactor),
        trailing_enabled: effectiveTrailing ? "1" : "0",
        trailing_stop_price: "0",
        // Multi-step trailing state machine — see
        // `realtime-processor.updateTrailingStop`. All three fields are
        // ratios (0.1 ≡ 10 %). When `trailing_start_ratio === "0"` the
        // legacy single-step code path runs (back-compat for positions
        // that pre-date this feature).
        trailing_start_ratio: hasTrailingProfile
          ? String(params.trailingStartRatio)
          : "0",
        trailing_stop_ratio: hasTrailingProfile
          ? String(params.trailingStopRatio)
          : "0",
        // CRITICAL: Validate stepRatio is positive and finite before storing.
        // If stepRatio is 0, NaN, or negative, re-anchoring breaks (infinite loops
        // or immediate re-triggers). Default to stopRatio/2 if invalid.
        trailing_step_ratio: hasTrailingProfile
          ? (() => {
              const stepRatio = params.trailingStepRatio || 0
              if (!Number.isFinite(stepRatio) || stepRatio <= 0) {
                const fallback = (params.trailingStopRatio || 0) / 2
                return String(Number.isFinite(fallback) && fallback > 0 ? fallback : 0.01)
              }
              return String(stepRatio)
            })()
          : "0",
        // Activation state — flipped to "1" the first cycle in which
        // `gain_ratio >= trailing_start_ratio`. Until then trailing is
        // dormant and only the fixed TP/SL gates fire.
        trailing_active: "0",
        // High-water mark anchor for the ratchet. Long: highest price
        // seen since activation. Short: lowest price seen.
        trailing_anchor: "0",
        status: "open",
        opened_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      }

      // ── Atomic pipeline for all creation-side index writes ───────────
      // Previously these were 4 separate awaits. A crash or concurrent
      // caller between any two of them left the index in a partial state
      // (hash exists but isn't in positionsSetKey, or configSetKey isn't
      // marked active). A single pipeline with exec() ensures all writes
      // land atomically from Redis's perspective — or none do.
      const createPipeline = client.multi()
      createPipeline.hset(this.positionKey(id), positionData)
      createPipeline.sadd(this.positionsSetKey(), id)
      // Register this configSetKey as active for O(1) duplicate detection on next creation
      createPipeline.sadd(this.activeConfigKeysSetKey(), configSetKey)
      // P0-4: Register this position id into the per-direction set so
      // `canCreatePosition` can enforce the spec cap
      // (`maxActiveBasePseudoPositionsPerDirection`, default 1) via O(1)
      // SCARD on the very next call. Removed on close.
      createPipeline.sadd(this.activeByDirectionKey(params.side), id)
      await createPipeline.exec()

      this.invalidateCache()
      await this.updateActivePositionsCount()

      // Broadcast position creation to connected clients
      emitPositionUpdate(this.connectionId, {
        id,
        symbol: params.symbol,
        currentPrice: params.entryPrice,
        unrealizedPnl: 0,
        unrealizedPnlPercent: 0,
        status: 'open',
      })

      return id
    } catch (error) {
      console.error("[v0] Failed to create pseudo position:", error)
      return null
    }
  }

  /**
   * Get active pseudo positions
   */
  async getActivePositions(): Promise<any[]> {
    try {
      const now = Date.now()
      if (this.activePositionsCache && now - this.cacheTimestamp < this.CACHE_TTL_MS) {
        return this.activePositionsCache
      }

      const positions = await this.listPositions({ status: "open" })

      // Sort by opened_at DESC
      positions.sort((a, b) => {
        const tA = new Date(a.opened_at || 0).getTime()
        const tB = new Date(b.opened_at || 0).getTime()
        return tB - tA
      })

      this.activePositionsCache = positions
      this.cacheTimestamp = now

      return positions
    } catch (error) {
      console.error("[v0] Failed to get active positions:", error)
      return []
    }
  }

  /**
   * Update a pseudo-position with the latest market price.
   *
   * Hot-path optimisations (critical at 100ms tick intervals):
   *
   *   1. **Pre-loaded position object.** The realtime processor already
   *      has the full position hash in-memory from `getActivePositions`,
   *      so we accept it as an optional `existingPosition` and skip the
   *      redundant `readPosition` HGETALL round-trip. Legacy callers
   *      that don't pass one fall back to the old behaviour.
   *
   *   2. **Write elision.** Prices do NOT move on every 100ms tick —
   *      the market-data feed typically refreshes at sub-second cadence
   *      with many consecutive ticks returning identical prices. We
   *      skip the Redis HSET entirely when the incoming price matches
   *      the last-known `current_price` within a tight epsilon
   *      (0.0001%). The broadcast is also skipped in that case, since
   *      dashboards have nothing new to render. This turns a "N-RTT-
   *      per-tick" cost into "only when price actually moved."
   *
   *   3. **Last-written memoisation.** We track per-position last-seen
   *      price in-memory to avoid parsing the previous `current_price`
   *      string out of the hash on every tick.
   */
  async updatePosition(
    positionId: string,
    currentPrice: number,
    existingPosition?: Record<string, string> | null,
  ): Promise<void> {
    try {
      const client = getRedisClient()

      // Prefer the caller-supplied position to avoid an extra HGETALL.
      const position = existingPosition ?? (await this.readPosition(positionId))
      if (!position) return

      // Compare against last-written price. First tick (no memo) uses
      // the persisted `current_price` so we don't fire a redundant
      // write just because the processor restarted.
      const memoPrice = this.lastWrittenPrice.get(positionId)
      const prevPrice = memoPrice ?? parseFloat(position.current_price || "0")
      const epsilon = prevPrice > 0 ? Math.max(prevPrice * 1e-6, 1e-9) : 0
      const priceMoved = Math.abs(currentPrice - prevPrice) > epsilon

      if (priceMoved) {
        await client.hset(this.positionKey(positionId), {
          current_price: String(currentPrice),
          updated_at: new Date().toISOString(),
        })
        // FIFO-evict oldest entry if the memo grows beyond a safety cap.
        // Entries are normally cleared on close via `closePosition` →
        // `lastWrittenPrice.delete(positionId)`, so this branch only
        // fires for abandoned position ids (e.g. a close signal lost
        // mid-transaction). Keeps long-running engine memory bounded.
        if (this.lastWrittenPrice.size >= PseudoPositionManager.MAX_PRICE_MEMO && !this.lastWrittenPrice.has(positionId)) {
          const oldest = this.lastWrittenPrice.keys().next().value
          if (oldest !== undefined) this.lastWrittenPrice.delete(oldest)
        }
        this.lastWrittenPrice.set(positionId, currentPrice)

        // Calculate unrealized PnL for the broadcast only — skipping
        // the broadcast when nothing moved eliminates a huge amount of
        // WebSocket chatter on quiet symbols.
        const entryPrice = parseFloat(position.entry_price || "0")
        const quantity = parseFloat(position.quantity || "0")
        const side = position.side || "long"
        const unrealizedPnl = side === "long"
          ? (currentPrice - entryPrice) * quantity
          : (entryPrice - currentPrice) * quantity
        const unrealizedPnlPercent =
          entryPrice > 0 && quantity > 0
            ? (unrealizedPnl / (entryPrice * quantity)) * 100
            : 0

        emitPositionUpdate(this.connectionId, {
          id: positionId,
          symbol: position.symbol,
          currentPrice,
          unrealizedPnl,
          unrealizedPnlPercent,
          status: "open",
        })
      }
    } catch (error) {
      console.error(`[v0] Failed to update position ${positionId}:`, error)
    }
  }

  /**
   * Close a pseudo-position with the given reason.
   *
   * Accepts an optional pre-loaded `existingPosition` hash (mirrors the
   * `updatePosition` optimisation) so the realtime processor can reuse
   * the object it already holds instead of issuing an extra HGETALL on
   * every TP/SL hit.
   *
   * All state-mutation writes for this connection (status flip, index
   * removals, TTL, Set append for prev-position context, heartbeat) are
   * issued as a SINGLE Redis pipeline via `client.multi()`. The previous
   * serial implementation paid 6–7 RTTs per close which was material on
   * hot symbols — pipelining collapses that to one. The strategy-Set
   * append is composed into the same pipeline rather than going through
   * `StrategyConfigManager.addPosition` (which would open its own
   * second pipeline) to keep everything in one atomic batch.
   */
  async closePosition(
    positionId: string,
    reason: string,
    existingPosition?: Record<string, string> | null,
  ): Promise<void> {
    try {
      const position = existingPosition ?? (await this.readPosition(positionId))
      if (!position) return

      const entryPrice = parseFloat(position.entry_price || "0")
      const currentPrice = parseFloat(position.current_price || "0")
      const quantity = parseFloat(position.quantity || "0")
      const side = position.side || "long"

      const {
        grossPnl,
        positionCost,
        netPnl: pnl,
        grossPnlPct,
        netPnlPct,
        notional,
      } = calculatePseudoClosePnl({ entryPrice, currentPrice, quantity, side })

      const client = getRedisClient()
      const closedAtIso = new Date().toISOString()
      const configSetKey = position.config_set_key || ""
      // Prefer the explicit `strategy_config_id` field when present — it's
      // the authoritative StrategyConfig.id (DB primary key) that the
      // historic prehistoric processor keyed its Set writes with. Fall
      // through to parsing `config_set_key` only for legacy rows written
      // before the field existed. When neither produces a truthy id, we
      // skip the Set writeback entirely rather than write to a phantom
      // list whose key no reader ever hits.
      const configId =
        String(position.strategy_config_id || "").trim() ||
        StrategyConfigManager.extractConfigId(configSetKey)

      // Build the single close-path pipeline.
      const pipeline = client.multi()
      pipeline.hset(this.positionKey(positionId), {
        status: "closed",
        closed_at: closedAtIso,
        close_reason: reason,
        realized_pnl: String(pnl),
        gross_realized_pnl: String(grossPnl),
        position_cost: String(positionCost),
        position_cost_ratio: String(PSEUDO_POSITION_CLOSE_COST_RATIO),
        realized_pnl_pct: String(netPnlPct),
        gross_realized_pnl_pct: String(grossPnlPct),
      })
      pipeline.srem(this.positionsSetKey(), positionId)
      if (configSetKey) {
        pipeline.srem(this.activeConfigKeysSetKey(), configSetKey)
        // Clean up the atomic gate on close so a future position with the
        // same config set key can be created immediately.
        const gateKey = `pseudo:gate:${this.connectionId}:${configSetKey}`
        pipeline.del(gateKey)
      }
      // P0-4: Free the per-direction slot so another position in the
      // same direction can open on the next cycle. Use the hash's
      // stored `side` so this stays correct for legacy positions that
      // predate the direction-indexed sets.
      if (side === "long" || side === "short") {
        pipeline.srem(this.activeByDirectionKey(side), positionId)
      }
      // 7-day TTL on the closed hash for operator forensics.
      pipeline.expire(this.positionKey(positionId), 604800)
      // ── Closed-positions index write (P-CTX-1) ───────────────────────
      // getPositionContext() in strategy-coordinator needs to read CLOSED
      // positions to compute prevPosCount / prevLosses / lastWins / lastLosses
      // for the Main-stage variant gates. These positions are removed from
      // positionsSetKey() above, so without this separate closed index the
      // context window is always empty and only the default variant runs.
      // We store the positionId in a Redis list (LPUSH = newest first),
      // capped to CLOSED_INDEX_CAP entries via LTRIM and with a 7-day TTL.
      const closedIndexKey = this.closedPositionsIndexKey()
      pipeline.lpush(closedIndexKey, positionId)
      pipeline.ltrim(closedIndexKey, 0, PseudoPositionManager.CLOSED_INDEX_CAP - 1)
      pipeline.expire(closedIndexKey, PseudoPositionManager.CLOSED_INDEX_TTL)

      // ── Continuous Set update (in same pipeline) ──────────────────
      // The realtime processor reads the HEAD of each strategy-config's
      // position list as its "prev position" context (first filled by
      // the prehistoric processor via StrategyConfigManager.addPositions).
      // We append each closed live position back into the SAME uniquely-
      // keyed list here so the Set stays continuously current, not
      // frozen at prehistoric-time. Entry serialisation goes through
      // the canonical static on StrategyConfigManager so writer and
      // reader never drift.
      // ── PI history accumulator (atomic, in-pipeline) ────────────────
      // Lifetime per (symbol × indicationType × direction) HASH that the
      // strategy coordinator reads at Base creation to blend prev-PI PF
      // into avgProfitFactor and at Real to tune size/leverage. Uses
      // hincrby so concurrent closes never lose a count, and composes
      // into the existing close pipeline so the whole transaction stays
      // one round-trip.
      try {
        const { recordPosClosed } = await import("@/lib/pos-history")
        const indicationType = String(
          position.indication_type ||
          position.signal_source     ||
          StrategyConfigManager.extractIndicationType(configSetKey) ||
          "unknown",
        )
        const directionRaw = side === "long" || side === "short" ? side : "long"
        const drawdownPctOrPx = parseFloat(position.max_drawdown || "0")
        const openedMs = new Date(
          String(position.opened_at || position.entry_time || position.created_at || closedAtIso),
        ).getTime()
        const closedMs = new Date(closedAtIso).getTime()
        const positionDurationMin =
          Number.isFinite(openedMs) && Number.isFinite(closedMs) && closedMs > openedMs
            ? (closedMs - openedMs) / 60000
            : 0
        // We don't track adverse-excursion duration separately — proxy
        // with full position duration when there was a drawdown sample,
        // 0 otherwise. Fine for cumulative averages.
        const drawdownMinutes = drawdownPctOrPx > 0 ? positionDurationMin : 0
        recordPosClosed({
          connectionId: this.connectionId,
          symbol: String(position.symbol || ""),
          indicationType,
          direction: directionRaw,
          pnl,
          drawdownMinutes,
          entryPrice,  // For cost-adjusted PF calculation
          quantity,    // For cost-adjusted PF calculation
          pipeline,
        })
      } catch (posErr) {
        // Non-critical; pos history is observability only.
        console.warn(`[v0] [closePosition] recordPosClosed failed:`, posErr)
      }

      if (configId) {
        const resultPct = netPnlPct
        // Canonical field on a live `pseudo_position` hash is `opened_at` (see
        // createPosition()). Historical/fill rows use `entry_time`. Legacy
        // rows used `created_at`. Fall through in priority order so the
        // prev-set entry ALWAYS carries the true entry timestamp — previously
        // it silently fell through to `closedAtIso` (= exit_time), which made
        // every live-closed writeback look like a zero-duration trade.
        const entryIso = String(
          position.opened_at ||
          position.entry_time ||
          position.created_at ||
          closedAtIso,
        )
        // Take-profit / stop-loss absolute prices live under different field
        // names depending on the writer:
        //   - `pseudo-position-manager.createPosition()` stores them as
        //     `takeprofit_price` / `stoploss_price` (canonical).
        //   - `config-set-processor.calculateStrategyPositions()` (historical
        //     fill) stores them as `take_profit` / `stop_loss`.
        // Read both so the Set entry exposes real levels regardless of origin.
        const tpPrice = parseFloat(
          position.takeprofit_price || position.take_profit || "0",
        )
        const slPrice = parseFloat(
          position.stoploss_price || position.stop_loss || "0",
        )
        const setEntry: StrategyPseudoPosition = {
          entry_time:  entryIso,
          symbol:      String(position.symbol || ""),
          entry_price: entryPrice,
          take_profit: tpPrice,
          stop_loss:   slPrice,
          status:      "closed",
          result:      resultPct,
          exit_time:   closedAtIso,
          exit_price:  currentPrice,
        }
        const setKey = `strategy:${this.connectionId}:config:${configId}:positions`
        pipeline.lpush(setKey, StrategyConfigManager.serializeSetEntry(setEntry))
        pipeline.ltrim(setKey, 0, StrategyConfigManager.MAX_POSITIONS - 1)
      }

      await pipeline.exec()

      // Clear the per-tick price memo so a reused id can't be elided.
      this.lastWrittenPrice.delete(positionId)

      this.invalidateCache()
      await this.updateActivePositionsCount()

      // ── Progression counter (P3-1) ────────────────────────────────────
      // Increment the connection-level totalTrades / successfulTrades counters
      // so the dashboard "Test Count" tile reflects all closed pseudo positions
      // (not just exchange-level live orders). `recordTrade` uses atomic
      // hincrby so concurrent closes never lose a count.
      try {
        const { ProgressionStateManager } = await import(
          "@/lib/progression-state-manager"
        )
        await ProgressionStateManager.recordTrade(this.connectionId, pnl >= 0, pnl)
      } catch (recordErr) {
        // Non-critical — counters will be slightly behind on failure.
        console.warn(`[v0] [closePosition] recordTrade failed for ${positionId}:`, recordErr)
      }

      // ── P1-2: Propagate close into BasePseudoPositionManager counters ──
      // Keeps Base-level win-rate / avg-profit / avg-loss / max-drawdown
      // stats up-to-date on every close so the Base → Main promotion
      // filter operates on current performance. If the pseudo row has no
      // `base_position_id` (legacy / unlinked positions), skip silently
      // — those rows never had a parent Base record to update.
      const basePositionId = String(position.base_position_id || "").trim()
      if (basePositionId) {
        try {
          const notional = entryPrice * quantity
          // Use any already-tracked adverse excursion, otherwise fall back
          // to `max(0, -netPnl)` as a coarse loss-only proxy. Realtime
          // processor writes `max_drawdown` on every tick when the live
          // unrealised PnL is lower than any prior sample.
          const storedDrawdown = parseFloat(position.max_drawdown || "0")
          const currentDrawdown = storedDrawdown > 0
            ? storedDrawdown
            : (pnl < 0 && notional > 0 ? Math.abs(pnl / notional) : 0)
          const { BasePseudoPositionManager } = await import(
            "@/lib/base-pseudo-position-manager"
          )
          const baseMgr = new BasePseudoPositionManager(this.connectionId)
          await baseMgr.updatePerformance(basePositionId, pnl, pnl > 0, currentDrawdown)
        } catch (err) {
          // Non-critical — Base counters will simply stay one cycle behind.
          console.error(
            `[v0] [P1-2] Failed to propagate close into Base performance (${basePositionId}):`,
            err,
          )
        }
      }

      // Broadcast position closure to connected clients
      emitPositionUpdate(this.connectionId, {
        id: positionId,
        symbol: position.symbol,
        currentPrice,
        unrealizedPnl: pnl,
        unrealizedPnlPercent: netPnlPct,
        status: "closed",
      })
    } catch (error) {
      console.error(`[v0] Failed to close position ${positionId}:`, error)
    }
  }

  /**
   * Get active position count
   */
  async getPositionCount(): Promise<number> {
    const active = await this.listPositions({ status: "open" })
    return active.length
  }

  /**
   * DEV/SIM-ONLY — realistic bounded rolling lifecycle.
   *
   * The simulated connector returns a CONSTANT mark price per symbol, so live
   * positions opened during a dev run never hit TP/SL and pile up unbounded
   * (per-symbol open → dozens). That has two downstream effects that keep the
   * strategy VARIANTS permanently dead in dev:
   *   1. `block` variant gate is `1 <= perSymbolOpen < blockMaxStack` — an open
   *      count of ~90 fails `< blockMaxStack` forever.
   *   2. No realistic CLOSED history accrues (and what little does closes at a
   *      stub price → pnl<=0), so `trailing` (needs >=2 recent wins) and `dca`
   *      (needs >=1 recent loss) never see the win/loss mix they gate on.
   *
   * This caps the per-symbol open book at `maxOpenPerSymbol` and rolls the
   * OLDEST excess positions to a realistic outcome — a TP-hit (win) or SL-hit
   * (loss) derived from each position's own profit factor — routing them
   * through `closePosition()` so they land in the closed index + pos-history
   * (which `getPositionContext` and the win/loss gates read). The result is a
   * realistic, continuously-cycling book: block sees 1..stack-1 open, and
   * trailing/dca see a genuine win/loss stream.
   *
   * No-op in PRODUCTION: there the real exchange marks live prices and closes
   * positions via real TP/SL, so the book bounds itself and these gates get
   * real data. We must never force-close real exchange positions.
   */
  async enforceSimBoundedLifecycle(
    symbol: string,
    opts: { maxOpenPerSymbol: number; minAgeMs?: number },
  ): Promise<{ closed: number; wins: number; losses: number }> {
    try {
      const minAgeMs = Math.max(0, opts.minAgeMs ?? 0)
      const cap = Math.max(0, Math.floor(opts.maxOpenPerSymbol))
      const now = Date.now()
      // Oldest-first so we roll the longest-held positions, like a real book.
      const open = (await this.listPositions({ status: "open", symbol })).sort(
        (a, b) => new Date(a.opened_at || 0).getTime() - new Date(b.opened_at || 0).getTime(),
      )
      const eligible = open.filter(
        (p) => now - new Date(p.opened_at || p.created_at || 0).getTime() >= minAgeMs,
      )
      const excess = Math.max(0, eligible.length - cap)
      if (excess <= 0) return { closed: 0, wins: 0, losses: 0 }

      let wins = 0
      let losses = 0
      for (let i = 0; i < excess; i++) {
        const pos = eligible[i]
        const entry = parseFloat(pos.entry_price || "0")
        if (!(entry > 0)) continue
        const side = pos.side === "short" ? "short" : "long"
        const pf = parseFloat(pos.profit_factor || "1") || 1
        // Win probability scales with the set's edge (PF). Clamp to a sane
        // band so even a PF=1 set produces a realistic mix, never all-or-none.
        const winProb = Math.max(0.2, Math.min(0.8, 0.45 + (pf - 1) * 0.3))
        // Deterministic per-position roll (stable across retries; varies by id).
        const roll = this.deterministicUnit(pos.id)
        const isWin = roll < winProb
        const tp = parseFloat(pos.takeprofit_price || pos.take_profit || "0")
        const sl = parseFloat(pos.stoploss_price || pos.stop_loss || "0")
        // Realistic exit: a winner exits at its take-profit, a loser at its
        // stop-loss. Fall back to a small side-correct move if TP/SL absent.
        let closePrice: number
        if (isWin) closePrice = tp > 0 ? tp : entry * (side === "long" ? 1.01 : 0.99)
        else closePrice = sl > 0 ? sl : entry * (side === "long" ? 0.99 : 1.01)
        await this.closePosition(pos.id, isWin ? "sim_tp_hit" : "sim_sl_hit", {
          ...pos,
          side,
          current_price: String(closePrice),
        })
        if (isWin) wins++
        else losses++
      }
      return { closed: excess, wins, losses }
    } catch (e) {
      console.warn(`[v0] enforceSimBoundedLifecycle failed for ${symbol}:`, e)
      return { closed: 0, wins: 0, losses: 0 }
    }
  }

  /** Deterministic uniform value in [0,1) derived from a string (FNV-1a). */
  private deterministicUnit(s: string): number {
    let h = 2166136261
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i)
      h = Math.imul(h, 16777619)
    }
    return ((h >>> 0) % 100000) / 100000
  }

  /**
   * Update active positions count in engine state (Redis).
   *
   * ── Atomic single-field write (P0-3 race fix) ─────────────────────
   * The previous implementation was a classic read-modify-write:
   *
   *     const current = await getSettings(stateKey)
   *     await setSettings(stateKey, { ...current, active_positions_count: count })
   *
   * — which spread the entire fetched hash back through `setSettings` →
   * `client.hset(...)`. Field-level merge means we never wiped the hash,
   * but ANY field that another writer (realtime heartbeat, engine
   * startup, watchdog re-arm) updated between our read and our write
   * would be silently overwritten with the stale value we'd read.
   * Worst-case: heartbeat-set `last_realtime_run` flapped backwards
   * every time createPosition / closePosition fired concurrently with a
   * realtime tick, breaking the dashboard's "engine is alive" signal.
   *
   * Now: count the active positions and write JUST that one field via
   * `client.hset(stateKey, "active_positions_count", String(count))`.
   * No read, no spread, no race — every other field on the hash is
   * untouched. The realtime processor's heartbeat path is unaffected
   * (it writes its own fields with its own hset).
   */
  private async updateActivePositionsCount(): Promise<void> {
    try {
      const count = await this.getPositionCount()
      const stateKey = `trade_engine_state:${this.connectionId}`
      const client = getRedisClient()
      // Single-field hset is atomic at the Redis level; safe under any
      // concurrency. We don't bother re-reading other fields because we
      // don't need them — only this one is being updated.
      await client.hset(stateKey, "active_positions_count", String(count))
    } catch (error) {
      console.error("[v0] Failed to update active positions count:", error)
    }
  }

  /**
   * Get position statistics
   */
  async getPositionStats(): Promise<any> {
    try {
      const allPositions = await this.listPositions()

      const active = allPositions.filter(p => p.status === "open")
      const closed = allPositions.filter(p => p.status === "closed")
      const activeLong = active.filter(p => p.side === "long").length
      const activeShort = active.filter(p => p.side === "short").length

      // Closed-position PnL is authoritative in the stored `realized_pnl`
      // field (written atomically during closePosition() from the live
      // current_price at close time). Recomputing from current_price here
      // risked drift because:
      //   - `updatePosition` elides Redis writes on tiny price moves,
      //     which meant the hash's `current_price` could lag the price
      //     that was live when TP/SL actually triggered;
      //   - for closed rows the semantically correct value to report is
      //     realised PnL, not a mark-to-market recomputation.
      // We still fall back to the recompute path for any legacy row
      // that predates the `realized_pnl` field, so nothing regresses.
      let totalPnl = 0
      let pnlLong = 0
      let pnlShort = 0
      let closedLongCount = 0
      let closedShortCount = 0

      for (const p of closed) {
        const side = p.side || "long"
        let pnl: number
        const stored = p.realized_pnl != null ? parseFloat(p.realized_pnl) : NaN
        if (Number.isFinite(stored)) {
          pnl = stored
        } else {
          const entry = parseFloat(p.entry_price || "0")
          const current = parseFloat(p.current_price || "0")
          const qty = parseFloat(p.quantity || "0")
          pnl = calculatePseudoClosePnl({ entryPrice: entry, currentPrice: current, quantity: qty, side }).netPnl
        }
        totalPnl += pnl
        if (side === "long") {
          pnlLong += pnl
          closedLongCount++
        } else {
          pnlShort += pnl
          closedShortCount++
        }
      }

      const totalRealizedPct = closed.length > 0
        ? closed.reduce((acc, p) => {
            const entry = parseFloat(p.entry_price || "0")
            const qty = parseFloat(p.quantity || "0")
            const notional = entry * qty
            if (!(notional > 0)) return acc
            const stored = p.realized_pnl != null ? parseFloat(p.realized_pnl) : NaN
            const pnl = Number.isFinite(stored)
              ? stored
              : (() => {
                  const current = parseFloat(p.current_price || "0")
                  const side = p.side || "long"
                  return calculatePseudoClosePnl({ entryPrice: entry, currentPrice: current, quantity: qty, side }).netPnl
                })()
            return acc + (pnl / notional) * 100
          }, 0)
        : 0

      return {
        total_positions: allPositions.length,
        active_positions: active.length,
        active_long: activeLong,
        active_short: activeShort,
        closed_positions: closed.length,
        total_pnl: totalPnl,
        avg_pnl: closed.length > 0 ? totalPnl / closed.length : 0,
        avg_pnl_long: closedLongCount > 0 ? pnlLong / closedLongCount : 0,
        avg_pnl_short: closedShortCount > 0 ? pnlShort / closedShortCount : 0,
        avg_pnl_pct: closed.length > 0 ? totalRealizedPct / closed.length : 0,
      }
    } catch (error) {
      console.error("[v0] Failed to get position stats:", error)
      return null
    }
  }

  /**
   * Check if a new position can be created for the given config set key + side.
   *
   * Two gates (both must pass):
   *   1. **Per-Set uniqueness** (pre-existing): exactly 1 active pseudo
   *      position per unique config combination (indType:dir:tp:sl:…).
   *      O(1) via SISMEMBER on `activeConfigKeysSetKey` — backed by a
   *      5 s `SET NX EX` mutex gate (`gateKey`) so two concurrent
   *      `createPosition` callers for the same configSetKey can't both
   *      pass the gate simultaneously.
   *   2. **Per-direction cap** (P0-4): hard cap on concurrent pseudo
   *      positions PER DIRECTION (Long/Short) across ALL config Sets.
   *      Cap comes from the operator-tunable setting
   *      `maxActiveBasePseudoPositionsPerDirection` (default 1, spec).
   *      O(1) via SCARD on `activeByDirectionKey(side)`.
   *
   * STALE-LOCK FIX: The SET NX mutex TTL is only 5 s. If a process that
   * acquired the gate and inserted into `activeConfigKeysSetKey` crashes
   * without cleaning up, the gateKey expires but the SISMEMBER entry
   * remains stale — permanently blocking future retries. Gate 1 defends
   * against this SINK: when `isMember=true` AND the gate mutex is NOT
   * held (our SET NX already succeeded), we remove the stale entry with
   * Redis `SREM` before returning false. The next caller (a fresh tick)
   * will see a clean set and proceed normally.
   *
   * Gate 2 is the new piece — previously only gate 1 existed, which
   * meant N distinct Sets could each hold 1 active long → N×1 longs
   * (unbounded). Spec: *"Active Pseudo Position Limit for each
   * direction Long,short maximal 1"*.
   */
  private async canCreatePosition(
    symbol: string,
    configSetKey: string,
    side?: "long" | "short",
  ): Promise<boolean> {
    try {
      const client = getRedisClient()
      // Gate 1: SET NX mutex (5 s TTL) + double-check via SISMEMBER.
      // SISMEMBER + SADD was racy: both callers could see `false` before
      // either added to the set, producing duplicate positions.
      const gateKey = `pseudo:gate:${this.connectionId}:${configSetKey}`
      const acquired = await client.set(gateKey, "1", { NX: true, EX: 5 })
      if (!acquired) return false
      // Second check: the Set may already contain the key from a prior run
      // (the gate TTL expired but the Set entry persisted). Double-check.
      const isMember = await client.sismember(this.activeConfigKeysSetKey(), configSetKey)
      if (isMember) {
        // STALE-LOCK REPAIR: The gate mutex expired (5 s TTL) but the
        // key is still in the active set — this means the prior owner
        // crashed without cleaning up. Remove the stale entry with SREM
        // so future ticks are not permanently blocked for this configKey.
        try {
          await client.srem(this.activeConfigKeysSetKey(), configSetKey)
        } catch { /* best-effort sink clearing */ }
        // Release the gate so another tick on a different configKey
        // (or the same configKey after the stale entry was removed)
        // can proceed without waiting 5 s.
        await client.del(gateKey).catch(() => {})
        return false
      }

      // Gate 2: per-direction cap (SCARD). When `side` is not supplied
      // (legacy callers), skip the per-direction gate to preserve
      // backwards compatibility — the setting is enforced at
      // `createPosition` which always passes `side`.
      if (side) {
        const cap = await this.getMaxActivePerDirection()
        const count = await client.scard(this.activeByDirectionKey(side))
        if (Number(count) >= cap) {
          return false
        }
      }
      return true
    } catch (error) {
      console.error("[v0] Failed to check position limit:", error)
      // On Redis error fall through and allow creation (fail-open).
      // The spec default of 1 per direction is enforced via the cap
      // cache's default, so a brief cache miss during a Redis blip
      // won't let the cap silently drift.
      return true
    }
  }

  /**
   * Get position count by direction
   */
  async getPositionCountByDirection(side: "long" | "short"): Promise<number> {
    const positions = await this.listPositions({ status: "open", side })
    return positions.length
  }

  /**
   * Invalidate position cache
   */
  private invalidateCache(): void {
    this.activePositionsCache = null
    this.cacheTimestamp = 0
  }

  /**
   * RECONCILIATION: Fix "millions of open pseudo positions at 8k Sets" bloat.
   *
   * Called on engine start (especially prod fast-path / auto-start) and
   * periodically. Closes any open pseudo positions whose configSetKey is no
   * longer present in the currently active strategy Sets. This prevents
   * unbounded growth when axis expansion + restarts + incomplete closes
   * leave orphaned positions.
   *
   * Also repairs the active_config_keys and direction indexes as a side effect.
   *
   * Returns number of positions closed during reconciliation.
   */
  async reconcileStaleOpenPositions(activeConfigSetKeys: Set<string>): Promise<number> {
    try {
      const client = getRedisClient()
      const openIds = await client.smembers(this.positionsSetKey())
      if (!openIds || openIds.length === 0) return 0

      let closed = 0
      const pipeline = client.multi()

      for (const id of openIds) {
        const hash = await client.hgetall(this.positionKey(id)).catch(() => ({} as any))
        const key = hash?.config_set_key || hash?.configSetKey || ""
        if (key && !activeConfigSetKeys.has(key)) {
          // Stale — close it with reconciliation reason so logistics (history, Base, counters) run
          pipeline.hset(this.positionKey(id), {
            status: "closed",
            closed_at: new Date().toISOString(),
            close_reason: "reconciliation_stale_set",
          })
          pipeline.srem(this.positionsSetKey(), id)
          if (key) {
            pipeline.srem(this.activeConfigKeysSetKey(), key)
          }
          const side = hash?.side
          if (side === "long" || side === "short") {
            pipeline.srem(this.activeByDirectionKey(side), id)
          }
          pipeline.expire(this.positionKey(id), 604800)
          closed++
        }
      }

      if (closed > 0) {
        await pipeline.exec()
        this.invalidateCache()
        await this.updateActivePositionsCount().catch(() => {})
        console.log(`[v0] [PseudoPosMgr] Reconciled and closed ${closed} stale pseudo positions (no longer in active Sets)`)
      }
      return closed
    } catch (err) {
      console.error("[v0] [PseudoPosMgr] Reconciliation failed:", err)
      return 0
    }
  }
}
