/**
 * Strategy Config Manager
 * Manages independent strategy configuration sets with pseudo positions
 * Each combination = independent set with max 250 positions
 */

import { initRedis, getRedisClient } from "@/lib/redis-db"
import { calculatePseudoClosePnl } from "@/lib/pseudo-position-costs"

export interface StrategyConfig {
  id: string
  connectionId: string
  position_cost_step: number // 2-20
  takeprofit: number // 0.001-0.5
  stoploss: number // 0.001-0.5
  trailing: boolean
  type: "MA_Cross" | "RSI_Band" | "MACD_Signal" | "Bollinger_Bounce" | string
  enabled: boolean
  createdAt: string
}

export interface PseudoPosition {
  entry_time: string
  symbol: string
  entry_price: number
  take_profit: number
  stop_loss: number
  status: "open" | "closed"
  result?: number // PnL percentage when closed
  exit_time?: string
  exit_price?: number
  /**
   * Direction of the trade — only carried on the in-memory PseudoPosition
   * shape used by the prehistoric calculator (see
   * ConfigSetProcessor.calculateStrategyPositions). The serialized
   * "|"-delimited Set entry does NOT include direction; this field exists
   * so the prehistoric write path can call recordPosClosed() with the
   * correct (long|short) bucket before persisting. See the systemwide
   * fix in commit history for "no sets evaluated → prehistoric fills
   * pos_history".
   */
  direction?: "long" | "short"
  /**
   * Indication type that drove this prehistoric position (e.g.
   * "MA_Cross", "RSI_Band"). Mirrors `StrategyConfig.type`. Only used
   * by the prehistoric write path to bucket into the correct
   * (symbol × type × direction) Pos history hash.
   */
  indication_type?: string
}

export interface StrategyStats {
  totalPositions: number
  openPositions: number
  closedPositions: number
  winRate: number
  totalPnL: number
  avgPnL: number
  bestTrade: number
  worstTrade: number
}

const MAX_POSITIONS = 250

export class StrategyConfigManager {
  private connectionId: string

  /**
   * Exposed cap so callers building their own pipelined writes (e.g.
   * PseudoPositionManager.closePosition, which composes the LPUSH +
   * LTRIM into the same close-path pipeline to save a round-trip) can
   * trim to the same bound without duplicating the constant.
   */
  static readonly MAX_POSITIONS = MAX_POSITIONS

  /**
   * Public serializer for pipeline composition. Identical to the
   * private `serializeEntry` used by `addPosition` / `addPositions` —
   * exposed so external pipelines never diverge from the canonical
   * "|"-delimited entry schema owned by this class.
   */
  static serializeSetEntry(p: PseudoPosition): string {
    return StrategyConfigManager.serializeEntry(p)
  }

  constructor(connectionId: string) {
    this.connectionId = connectionId
  }

  private getConfigKey(configId: string): string {
    return `strategy:${this.connectionId}:config:${configId}`
  }

  private getPositionsKey(configId: string): string {
    return `strategy:${this.connectionId}:config:${configId}:positions`
  }

  private getConfigIndexKey(): string {
    return `strategy:${this.connectionId}:configs:index`
  }

  private async scanConfigKeys(client: any): Promise<string[]> {
    // Startup/repair fallback only: bounded SCAN backfills the maintained
    // strategy config index for legacy configs. Normal reads never scan.
    const pattern = `strategy:${this.connectionId}:config:*`
    const keys: string[] = []
    if (typeof client.scan !== "function") return keys
    let cursor = "0"
    do {
      const result = await client.scan(cursor, "MATCH", pattern, "COUNT", 100).catch(() => null)
      if (!result) break
      cursor = String(result[0] ?? "0")
      const batch = (result[1] || []).filter((k: string) => !k.endsWith(":positions"))
      keys.push(...batch)
    } while (cursor !== "0")
    return keys
  }

  async createConfig(config: Omit<StrategyConfig, "connectionId" | "createdAt">): Promise<StrategyConfig> {
    await initRedis()
    const client = getRedisClient()

    const fullConfig: StrategyConfig = {
      ...config,
      connectionId: this.connectionId,
      createdAt: new Date().toISOString(),
    }

    const key = this.getConfigKey(config.id)
    const pipeline = client.multi()
    pipeline.set(key, JSON.stringify(fullConfig))
    pipeline.sadd(this.getConfigIndexKey(), key)
    await pipeline.exec()

    console.log(`[v0] [StrategyConfigManager] Created config ${config.id} for ${this.connectionId}`)
    return fullConfig
  }

  async getConfig(configId: string): Promise<StrategyConfig | null> {
    await initRedis()
    const client = getRedisClient()

    const key = this.getConfigKey(configId)
    const data = await client.get(key)

    if (!data) return null
    return JSON.parse(typeof data === "string" ? data : JSON.stringify(data))
  }

  async getAllConfigs(): Promise<StrategyConfig[]> {
    await initRedis()
    const client = getRedisClient()

    let keys = ((await client.smembers(this.getConfigIndexKey()).catch(() => [])) || []) as string[]
    if (keys.length === 0) {
      keys = await this.scanConfigKeys(client)
      if (keys.length > 0) await client.sadd(this.getConfigIndexKey(), ...keys).catch(() => 0)
    }
    if (keys.length === 0) return []

    const values = await Promise.all(keys.map((key: string) => client.get(key).catch(() => null)))
    const configs: StrategyConfig[] = []
    for (const data of values) {
      if (!data) continue
      try {
        configs.push(JSON.parse(typeof data === "string" ? data : JSON.stringify(data)))
      } catch { /* skip malformed */ }
    }

    return configs
  }

  async updateConfig(configId: string, updates: Partial<StrategyConfig>): Promise<void> {
    await initRedis()
    const client = getRedisClient()

    const config = await this.getConfig(configId)
    if (!config) {
      throw new Error(`Config ${configId} not found`)
    }

    const updated = { ...config, ...updates }
    const key = this.getConfigKey(configId)
    const pipeline = client.multi()
    pipeline.set(key, JSON.stringify(updated))
    pipeline.sadd(this.getConfigIndexKey(), key)
    await pipeline.exec()

    console.log(`[v0] [StrategyConfigManager] Updated config ${configId}`)
  }

  async deleteConfig(configId: string): Promise<void> {
    await initRedis()
    const client = getRedisClient()

    const configKey = this.getConfigKey(configId)
    const positionsKey = this.getPositionsKey(configId)

    const pipeline = client.multi()
    pipeline.del(configKey)
    pipeline.del(positionsKey)
    pipeline.srem(this.getConfigIndexKey(), configKey)
    await pipeline.exec()

    console.log(`[v0] [StrategyConfigManager] Deleted config ${configId}`)
  }

  /**
   * Serialize one `PseudoPosition` into the canonical "|"-delimited
   * entry string. Kept as a static so every writer (live writeback,
   * prehistoric fill) and every reader (`parseEntry`) shares the exact
   * same schema with zero drift.
   */
  private static serializeEntry(p: PseudoPosition): string {
    return [
      p.entry_time,
      p.symbol,
      p.entry_price.toString(),
      p.take_profit.toString(),
      p.stop_loss.toString(),
      p.status,
      p.result?.toString() || "0",
      p.exit_time || "",
      p.exit_price?.toString() || "0",
    ].join("|")
  }

  /**
   * Append one position to the config's Set. LPUSH + LTRIM are issued
   * as a single Redis pipeline (one RTT) instead of two serial awaits —
   * the tradeoff of going from 2 RTTs to 1 is material on the realtime
   * close path where this is called on every TP/SL hit.
   */
  async addPosition(configId: string, position: PseudoPosition): Promise<void> {
    await initRedis()
    const client = getRedisClient()
    const key = this.getPositionsKey(configId)
    const entry = StrategyConfigManager.serializeEntry(position)
    const pipeline = client.multi()
    pipeline.lpush(key, entry)
    pipeline.ltrim(key, 0, MAX_POSITIONS - 1)
    await pipeline.exec()
  }

  /**
   * Batch variant — pushes many positions for a config with a single
   * pipelined LPUSH + LTRIM. Used by the prehistoric processor to cut
   * per-position Redis round-trips by a factor of N.
   */
  async addPositions(configId: string, positions: PseudoPosition[]): Promise<void> {
    if (!positions || positions.length === 0) return
    await initRedis()
    const client = getRedisClient()
    const key = this.getPositionsKey(configId)
    const entries = positions.map((p) => StrategyConfigManager.serializeEntry(p))
    const pipeline = client.multi()
    pipeline.lpush(key, ...entries)
    pipeline.ltrim(key, 0, MAX_POSITIONS - 1)
    await pipeline.exec()
  }

  async getPositions(configId: string, limit = 50): Promise<PseudoPosition[]> {
    await initRedis()
    const client = getRedisClient()

    const key = this.getPositionsKey(configId)
    const rawPositions = await client.lrange(key, 0, limit - 1)

    return rawPositions.map((entry: string) => StrategyConfigManager.parseEntry(entry)).filter(
      (p): p is PseudoPosition => p !== null,
    )
  }

  /**
   * Return the most recently appended CLOSED position for a given
   * config, or `null` if the set has no closed rows. This is the single
   * canonical "prev-position retrieval" primitive — both the historic
   * fill path and the realtime tick use it, so we never drift on the
   * entry schema.
   *
   * ── P2-2: closed-only enforcement ─────────────────────────────────
   * The strategy config positions list mixes open + closed entries
   * (the prehistoric fill path appends every pseudo trade it creates,
   * including ones that were still open at snapshot time). The Main-
   * stage position-factor coordination must calibrate against CLOSED
   * outcomes only (spec: *"Calculations of Sets on Main of Pos Factors
   * Coordinations have to Base on Closed Pseudo Positions Only, dont
   * include Open ones"*), so this reader now scans up to 20 HEAD rows
   * for the first `status==="closed"` entry. Fast path stays O(1)
   * when HEAD is already closed (the common case because new rows are
   * appended open-then-updated-to-closed in the same tick); worst
   * case is a bounded 20-row scan to skip a cluster of still-open
   * entries.
   */
  async getLatestPosition(configId: string): Promise<PseudoPosition | null> {
    await initRedis()
    const client = getRedisClient()
    const key = this.getPositionsKey(configId)
    // Scan a small HEAD window so the common "HEAD is closed" fast path
    // stays O(1) while still being able to skip a burst of still-open
    // rows at the top of the list.
    const SCAN_WINDOW = 20
    const rows = await client.lrange(key, 0, SCAN_WINDOW - 1)
    if (!rows || rows.length === 0) return null
    for (const row of rows) {
      const parsed = StrategyConfigManager.parseEntry(String(row))
      if (parsed && parsed.status === "closed") return parsed
    }
    // No closed row in the head window — treat as "no prior outcome"
    // rather than returning an open row that would pollute downstream
    // calibration.
    return null
  }

  /**
   * Parse one "|"-delimited position entry back into a `PseudoPosition`.
   * Symmetric to the serialization used by `addPosition`/`addPositions`,
   * so every reader and writer in the codebase shares the same schema.
   */
  static parseEntry(entry: string): PseudoPosition | null {
    if (!entry) return null
    const parts = entry.split("|")
    if (parts.length < 6) return null
    return {
      entry_time:  parts[0] || "",
      symbol:      parts[1] || "",
      entry_price: parseFloat(parts[2] || "0") || 0,
      take_profit: parseFloat(parts[3] || "0") || 0,
      stop_loss:   parseFloat(parts[4] || "0") || 0,
      status:      (parts[5] as "open" | "closed") || "closed",
      result:      parseFloat(parts[6] || "0") || 0,
      exit_time:   parts[7] || undefined,
      exit_price:  parts[8] ? (parseFloat(parts[8]) || undefined) : undefined,
    }
  }

  /**
   * Extract the canonical configId embedded in a pseudo-position's
   * composite `config_set_key`. The trailing segment is always the
   * strategy-config id — see `config-set-processor` for how the key is
   * assembled. Returns an empty string when absent so callers can
   * short-circuit cheaply.
   */
  static extractConfigId(configSetKey: string | undefined | null): string {
    if (!configSetKey) return ""
    const raw = String(configSetKey)
    const idx = raw.lastIndexOf(":")
    return idx >= 0 ? raw.slice(idx + 1) : raw
  }

  /**
   * Best-effort indication-type extraction from a composite configSetKey.
   * The keys produced upstream embed the indication type as one of the
   * leading segments (e.g. `direction:long:cfg_…` or
   * `connId:active_advanced:short:cfg_…`). We scan for the first segment
   * that matches our known type vocabulary and return it lower-cased;
   * returns "" when no recognised token appears (callers fall back to
   * "unknown" rather than dropping the position from PI history).
   */
  static extractIndicationType(configSetKey: string | undefined | null): string {
    if (!configSetKey) return ""
    const KNOWN = new Set([
      "direction",
      "move",
      "active",
      "active_advanced",
      "optimal",
      "auto",
    ])
    for (const seg of String(configSetKey).split(":")) {
      const s = seg.trim().toLowerCase()
      if (KNOWN.has(s)) return s
    }
    return ""
  }

  async getPositionCount(configId: string): Promise<number> {
    await initRedis()
    const client = getRedisClient()

    const key = this.getPositionsKey(configId)
    return await client.llen(key)
  }

  async getStats(configId: string): Promise<StrategyStats> {
    const positions = await this.getPositions(configId, MAX_POSITIONS)

    const closedPositions = positions.filter((p) => p.status === "closed")
    const winningTrades = closedPositions.filter((p) => (p.result || 0) > 0)

    const totalPnL = closedPositions.reduce((sum, p) => sum + (p.result || 0), 0)
    const avgPnL = closedPositions.length > 0 ? totalPnL / closedPositions.length : 0
    const bestTrade = closedPositions.length > 0 ? Math.max(...closedPositions.map((p) => p.result || 0)) : 0
    const worstTrade = closedPositions.length > 0 ? Math.min(...closedPositions.map((p) => p.result || 0)) : 0

    return {
      totalPositions: positions.length,
      openPositions: positions.filter((p) => p.status === "open").length,
      closedPositions: closedPositions.length,
      winRate: closedPositions.length > 0 ? (winningTrades.length / closedPositions.length) * 100 : 0,
      totalPnL,
      avgPnL,
      bestTrade,
      worstTrade,
    }
  }

  async enableConfig(configId: string): Promise<void> {
    await this.updateConfig(configId, { enabled: true })
  }

  async disableConfig(configId: string): Promise<void> {
    await this.updateConfig(configId, { enabled: false })
  }

  async getEnabledConfigs(): Promise<StrategyConfig[]> {
    const allConfigs = await this.getAllConfigs()
    return allConfigs.filter((c) => c.enabled)
  }

  async generateDefaultConfigs(): Promise<StrategyConfig[]> {
    const configs: StrategyConfig[] = []
    let idCounter = 1

    const types = ["MA_Cross", "RSI_Band", "MACD_Signal", "Bollinger_Bounce"]
    const positionCostSteps = [2, 5, 10, 15]
    const takeprofitOptions = [0.01, 0.02, 0.05, 0.1]
    const stoplossOptions = [0.005, 0.01, 0.02, 0.05]

    for (const type of types) {
      for (const posCostStep of positionCostSteps) {
        for (const tp of takeprofitOptions) {
          for (const sl of stoplossOptions) {
            const config = await this.createConfig({
              id: `strat_${this.connectionId}_${idCounter++}`,
              position_cost_step: posCostStep,
              takeprofit: tp,
              stoploss: sl,
              trailing: false,
              type,
              enabled: true,
            })
            configs.push(config)

            if (configs.length >= 100) {
              return configs
            }
          }
        }
      }
    }

    return configs
  }

  async closePosition(
    configId: string,
    symbol: string,
    exitPrice: number,
    exitTime: string = new Date().toISOString()
  ): Promise<void> {
    await initRedis()
    const client = getRedisClient()

    const positions = await this.getPositions(configId, MAX_POSITIONS)
    const openPositions = positions.filter((p) => p.symbol === symbol && p.status === "open")

    for (const pos of openPositions) {
      const pnl = calculatePseudoClosePnl({
        entryPrice: pos.entry_price,
        currentPrice: exitPrice,
        quantity: 1,
        side: pos.direction || "long",
      }).netPnlPct
      const closedPos: PseudoPosition = {
        ...pos,
        status: "closed",
        result: pnl,
        exit_time: exitTime,
        exit_price: exitPrice,
      }

      await this.removePosition(configId, pos.entry_time, pos.symbol)
      await this.addPosition(configId, closedPos)
    }
  }

  private async removePosition(configId: string, entryTime: string, symbol: string): Promise<void> {
    await initRedis()
    const client = getRedisClient()

    const key = this.getPositionsKey(configId)
    const positions = await client.lrange(key, 0, -1)

    const filtered = positions.filter((entry: string) => {
      const parts = entry.split("|")
      return !(parts[0] === entryTime && parts[1] === symbol)
    })

    await client.del(key)
    for (const entry of filtered.reverse()) {
      await client.lpush(key, entry)
    }
  }

  async clearAllPositions(): Promise<void> {
    await initRedis()
    const client = getRedisClient()

    const configs = await this.getAllConfigs()
    for (const config of configs) {
      const key = this.getPositionsKey(config.id)
      await client.del(key)
    }

    console.log(`[v0] [StrategyConfigManager] Cleared all positions for ${this.connectionId}`)
  }

  async getBestPerformingConfig(): Promise<{ config: StrategyConfig; stats: StrategyStats } | null> {
    const configs = await this.getEnabledConfigs()
    if (configs.length === 0) return null
    // Pipeline the per-config stats reads — they are independent
    // Redis keys and the original sequential loop was N · RTT for an
    // N-config universe (often 50+).
    const all = await Promise.all(
      configs.map((config) => this.getStats(config.id).then((stats) => ({ config, stats }))),
    )
    return all.reduce<{ config: StrategyConfig; stats: StrategyStats } | null>(
      (best, cur) => (!best || cur.stats.winRate > best.stats.winRate ? cur : best),
      null,
    )
  }
}
