/**
 * Indication Config Manager
 * Manages independent indication configuration sets
 * Each combination of parameters = independent Redis set with max 250 results
 */

import { initRedis, getRedisClient } from "@/lib/redis-db"

export interface IndicationConfig {
  id: string
  connectionId: string
  steps: number // 2-30
  drawdown_ratio: number // 0.01-0.5
  active_ratio: number // 0.5-0.9
  last_part_ratio: number // 0.1-0.5
  type: "SMA" | "EMA" | "RSI" | "MACD" | "Bollinger" | "SAR" | string
  enabled: boolean
  createdAt: string
}

export interface IndicationResult {
  timestamp: string
  symbol: string
  value: number
  signal: "buy" | "sell" | "neutral"
  confidence?: number
}

const MAX_RESULTS = 250

export class IndicationConfigManager {
  private connectionId: string

  constructor(connectionId: string) {
    this.connectionId = connectionId
  }

  private getConfigKey(configId: string): string {
    return `indication:${this.connectionId}:config:${configId}`
  }

  private getResultsKey(configId: string): string {
    return `indication:${this.connectionId}:config:${configId}:results`
  }

  private getConfigIndexKey(): string {
    return `indication:${this.connectionId}:configs:index`
  }

  private async scanConfigKeys(client: any): Promise<string[]> {
    // Startup/repair fallback only: this bounded SCAN backfills the maintained
    // config index for legacy data created before the index existed. Normal
    // dashboard/hot-path reads use SMEMBERS on getConfigIndexKey().
    const pattern = `indication:${this.connectionId}:config:*`
    const keys: string[] = []
    if (typeof client.scan !== "function") return keys
    let cursor = "0"
    do {
      const result = await client.scan(cursor, "MATCH", pattern, "COUNT", 100).catch(() => null)
      if (!result) break
      cursor = String(result[0] ?? "0")
      const batch = (result[1] || []).filter((k: string) => !k.endsWith(":results"))
      keys.push(...batch)
    } while (cursor !== "0")
    return keys
  }

  async createConfig(config: Omit<IndicationConfig, "connectionId" | "createdAt">): Promise<IndicationConfig> {
    await initRedis()
    const client = getRedisClient()

    const fullConfig: IndicationConfig = {
      ...config,
      connectionId: this.connectionId,
      createdAt: new Date().toISOString(),
    }

    const key = this.getConfigKey(config.id)
    const pipeline = client.multi()
    pipeline.set(key, JSON.stringify(fullConfig))
    pipeline.sadd(this.getConfigIndexKey(), key)
    await pipeline.exec()

    console.log(`[v0] [IndicationConfigManager] Created config ${config.id} for ${this.connectionId}`)
    return fullConfig
  }

  async getConfig(configId: string): Promise<IndicationConfig | null> {
    await initRedis()
    const client = getRedisClient()

    const key = this.getConfigKey(configId)
    const data = await client.get(key)

    if (!data) return null
    return JSON.parse(typeof data === "string" ? data : JSON.stringify(data))
  }

  async getAllConfigs(): Promise<IndicationConfig[]> {
    await initRedis()
    const client = getRedisClient()

    let keys = ((await client.smembers(this.getConfigIndexKey()).catch(() => [])) || []) as string[]
    if (keys.length === 0) {
      keys = await this.scanConfigKeys(client)
      if (keys.length > 0) await client.sadd(this.getConfigIndexKey(), ...keys).catch(() => 0)
    }
    if (keys.length === 0) return []

    // Fan out all GETs in parallel — was O(N) serial round-trips.
    const values = await Promise.all(keys.map((k: string) => client.get(k).catch(() => null)))
    const configs: IndicationConfig[] = []
    for (const data of values) {
      if (!data) continue
      try {
        configs.push(JSON.parse(typeof data === "string" ? data : JSON.stringify(data)))
      } catch { /* skip malformed */ }
    }
    return configs
  }

  async updateConfig(configId: string, updates: Partial<IndicationConfig>): Promise<void> {
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

    console.log(`[v0] [IndicationConfigManager] Updated config ${configId}`)
  }

  async deleteConfig(configId: string): Promise<void> {
    await initRedis()
    const client = getRedisClient()

    const configKey = this.getConfigKey(configId)
    const resultsKey = this.getResultsKey(configId)

    const pipeline = client.multi()
    pipeline.del(configKey)
    pipeline.del(resultsKey)
    pipeline.srem(this.getConfigIndexKey(), configKey)
    await pipeline.exec()

    console.log(`[v0] [IndicationConfigManager] Deleted config ${configId}`)
  }

  async addResult(configId: string, result: IndicationResult): Promise<void> {
    await initRedis()
    const client = getRedisClient()

    const key = this.getResultsKey(configId)
    const entry = `${result.timestamp}|${result.symbol}|${result.value}|${result.signal}`

    await client.lpush(key, entry)
    await client.ltrim(key, 0, MAX_RESULTS - 1)
  }

  /**
   * Batch variant — pushes many results for a config with a single lpush and
   * a single ltrim. Used by the prehistoric processor to cut per-result
   * Redis round-trips by a factor of N.
   */
  async addResults(configId: string, results: IndicationResult[]): Promise<void> {
    if (!results || results.length === 0) return
    await initRedis()
    const client = getRedisClient()

    const key = this.getResultsKey(configId)
    const entries = results.map(
      (r) => `${r.timestamp}|${r.symbol}|${r.value}|${r.signal}`,
    )
    // lpush accepts varargs — spread once.
    await client.lpush(key, ...entries)
    await client.ltrim(key, 0, MAX_RESULTS - 1)
  }

  async getResults(configId: string, limit = 50): Promise<IndicationResult[]> {
    await initRedis()
    const client = getRedisClient()

    const key = this.getResultsKey(configId)
    const rawResults = await client.lrange(key, 0, limit - 1)

    return rawResults.map((entry: string) => {
      const [timestamp, symbol, valueStr, signal] = entry.split("|")
      return {
        timestamp,
        symbol,
        value: parseFloat(valueStr),
        signal: signal as "buy" | "sell" | "neutral",
      }
    })
  }

  async getResultCount(configId: string): Promise<number> {
    await initRedis()
    const client = getRedisClient()

    const key = this.getResultsKey(configId)
    return await client.llen(key)
  }

  async enableConfig(configId: string): Promise<void> {
    await this.updateConfig(configId, { enabled: true })
  }

  async disableConfig(configId: string): Promise<void> {
    await this.updateConfig(configId, { enabled: false })
  }

  async getEnabledConfigs(): Promise<IndicationConfig[]> {
    const allConfigs = await this.getAllConfigs()
    return allConfigs.filter((c) => c.enabled)
  }

  async generateDefaultConfigs(): Promise<IndicationConfig[]> {
    // Read per-connection minStep from Redis.
    // Only step-window sizes >= minStep are generated — raising the floor
    // eliminates fast short-window configs that tend to trigger on noise.
    let minStep = 5
    try {
      await initRedis()
      const client = getRedisClient()
      if (client) {
        const raw = await client.hget(`connection_settings:${this.connectionId}`, "minStep")
        const parsed = Number(raw)
        if (Number.isFinite(parsed) && parsed >= 2 && parsed <= 30) {
          minStep = Math.floor(parsed)
        }
      }
    } catch {
      // Redis unavailable — fall through to default (5)
    }

    const types = ["SMA", "EMA", "RSI", "MACD"]
    const ALL_STEPS = [2, 3, 5, 10, 15, 20, 25, 30]
    const stepsOptions = ALL_STEPS.filter((s) => s >= minStep)
    const drawdownOptions = [0.05, 0.1, 0.15]
    const activeRatioOptions = [0.6, 0.7, 0.8]
    const lastPartRatioOptions = [0.2, 0.3, 0.4]

    // Build all config objects in memory first — no I/O yet.
    const pending: Array<Omit<IndicationConfig, "connectionId" | "createdAt">> = []
    let idCounter = 1
    outer: for (const type of types) {
      for (const steps of stepsOptions) {
        for (const drawdown of drawdownOptions) {
          for (const activeRatio of activeRatioOptions) {
            for (const lastPartRatio of lastPartRatioOptions) {
              pending.push({
                id: `ind_${this.connectionId}_${idCounter++}`,
                steps,
                drawdown_ratio: drawdown,
                active_ratio: activeRatio,
                last_part_ratio: lastPartRatio,
                type,
                enabled: true,
              })
              if (pending.length >= 100) break outer
            }
          }
        }
      }
    }

    // Persist all configs in parallel — was sequential await per config.
    const now = new Date().toISOString()
    await initRedis()
    const client = getRedisClient()
    const pipe = client.multi()
    const configs: IndicationConfig[] = pending.map((cfg) => {
      const full: IndicationConfig = { ...cfg, connectionId: this.connectionId, createdAt: now }
      pipe.set(this.getConfigKey(cfg.id), JSON.stringify(full))
      return full
    })
    await pipe.exec()

    return configs
  }

  async clearAllResults(): Promise<void> {
    await initRedis()
    const client = getRedisClient()

    const configs = await this.getAllConfigs()
    for (const config of configs) {
      const key = this.getResultsKey(config.id)
      await client.del(key)
    }

    console.log(`[v0] [IndicationConfigManager] Cleared all results for ${this.connectionId}`)
  }
}
