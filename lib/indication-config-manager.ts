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

  async createConfig(config: Omit<IndicationConfig, "connectionId" | "createdAt">): Promise<IndicationConfig> {
    await initRedis()
    const client = getRedisClient()

    const fullConfig: IndicationConfig = {
      ...config,
      connectionId: this.connectionId,
      createdAt: new Date().toISOString(),
    }

    const key = this.getConfigKey(config.id)
    await client.set(key, JSON.stringify(fullConfig))

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

    const pattern = `indication:${this.connectionId}:config:*`
    const keys = await client.keys(pattern)

    const configs: IndicationConfig[] = []
    for (const key of keys) {
      if (key.endsWith(":results")) continue
      const data = await client.get(key)
      if (data) {
        configs.push(JSON.parse(typeof data === "string" ? data : JSON.stringify(data)))
      }
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
    await client.set(key, JSON.stringify(updated))

    console.log(`[v0] [IndicationConfigManager] Updated config ${configId}`)
  }

  async deleteConfig(configId: string): Promise<void> {
    await initRedis()
    const client = getRedisClient()

    const configKey = this.getConfigKey(configId)
    const resultsKey = this.getResultsKey(configId)

    await client.del(configKey)
    await client.del(resultsKey)

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
    const configs: IndicationConfig[] = []
    let idCounter = 1

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
    // Full candidate pool 2–30 at practical intervals.
    // Filter by operator-configured minStep floor.
    const ALL_STEPS = [2, 3, 5, 10, 15, 20, 25, 30]
    const stepsOptions = ALL_STEPS.filter(s => s >= minStep)
    const drawdownOptions = [0.05, 0.1, 0.15]
    const activeRatioOptions = [0.6, 0.7, 0.8]
    const lastPartRatioOptions = [0.2, 0.3, 0.4]

    for (const type of types) {
      for (const steps of stepsOptions) {
        for (const drawdown of drawdownOptions) {
          for (const activeRatio of activeRatioOptions) {
            for (const lastPartRatio of lastPartRatioOptions) {
              const config = await this.createConfig({
                id: `ind_${this.connectionId}_${idCounter++}`,
                steps,
                drawdown_ratio: drawdown,
                active_ratio: activeRatio,
                last_part_ratio: lastPartRatio,
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
    }

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
