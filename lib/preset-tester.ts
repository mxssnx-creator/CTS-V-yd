/**
 * Preset Configuration Tester - Redis-native
 * Tests configurations against historical data asynchronously
 */

import { resolveStopLossPercent } from "@/lib/tp-sl-ratio"
import { initRedis, getRedisClient, getSettings, setSettings } from "@/lib/redis-db"
import { TechnicalIndicators } from "./indicators"
import type { PresetConfiguration } from "./preset-config-generator"

export interface TestResult {
  configId: string
  profitFactor: number
  winRate: number
  totalTrades: number
  winningTrades: number
  losingTrades: number
  avgProfit: number
  avgLoss: number
  maxDrawdown: number
  drawdownHours: number
  sharpeRatio: number
}

export class PresetTester {
  private connectionId: string
  private testResults: Map<string, TestResult> = new Map()
  private progressCallback?: (progress: number, total: number) => void

  constructor(connectionId: string) {
    this.connectionId = connectionId
  }

  setProgressCallback(callback: (progress: number, total: number) => void) {
    this.progressCallback = callback
  }

  async testConfigurations(configurations: PresetConfiguration[], testPeriodHours = 12): Promise<Map<string, TestResult>> {
    console.log(`[v0] Testing ${configurations.length} configurations...`)

    const configsBySymbol = new Map<string, PresetConfiguration[]>()
    for (const config of configurations) {
      if (!configsBySymbol.has(config.symbol)) configsBySymbol.set(config.symbol, [])
      configsBySymbol.get(config.symbol)!.push(config)
    }

    let tested = 0
    const total = configurations.length
    const promises: Promise<void>[] = []

    for (const [symbol, configs] of configsBySymbol.entries()) {
      const promise = this.testSymbolConfigurations(symbol, configs, testPeriodHours).then(() => {
        tested += configs.length
        if (this.progressCallback) this.progressCallback(tested, total)
      })
      promises.push(promise)
    }

    await Promise.all(promises)
    console.log(`[v0] Completed testing ${tested} configurations`)
    return this.testResults
  }

  private async testSymbolConfigurations(symbol: string, configurations: PresetConfiguration[], testPeriodHours: number): Promise<void> {
    try {
      const marketData = await this.fetchMarketData(symbol, testPeriodHours)
      if (marketData.length < 10) {
        console.log(`[v0] Insufficient data for ${symbol}, skipping...`)
        return
      }

      for (const config of configurations) {
        const result = await this.testConfiguration(config, marketData)
        this.testResults.set(config.id, result)
      }
    } catch (error) {
      console.error(`[v0] Failed to test configurations for ${symbol}:`, error)
    }
  }

  private async fetchMarketData(symbol: string, hours: number): Promise<any[]> {
    try {
      await initRedis()
      const client = getRedisClient()
      const cutoff = Date.now() - hours * 60 * 60 * 1000

      // Get from Redis sorted set
      const dataIds = await client.zrangebyscore(`market_data:${this.connectionId}:${symbol}`, cutoff, "+inf")
      const data: any[] = []

      for (const dataId of dataIds) {
        const entry = await getSettings(`market_candle:${this.connectionId}:${symbol}:${dataId}`)
        if (entry) data.push(entry)
      }

      // If no candle data, try to get from the generic market data
      if (data.length === 0) {
        const allData = await getSettings(`market_data:${symbol}`)
        if (allData && Array.isArray(allData)) {
          return allData.filter((d: any) => new Date(d.timestamp).getTime() >= cutoff)
        }
      }

      return data.sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime())
    } catch (error) {
      console.error(`[v0] Failed to fetch market data for ${symbol}:`, error)
      return []
    }
  }

  private async testConfiguration(config: PresetConfiguration, marketData: any[]): Promise<TestResult> {
    const trades: any[] = []
    let balance = 10000
    let equity = balance
    let maxEquity = balance
    let maxDrawdown = 0
    let drawdownStart: Date | null = null
    let totalDrawdownHours = 0

    const prices = marketData.map((d) => parseFloat(d.close))

    for (let i = 20; i < marketData.length; i++) {
      const historicalPrices = prices.slice(0, i + 1)
      const signal = TechnicalIndicators.generateSignal(config.indicator, historicalPrices)

      if (signal.strength < 0.5) continue

      const entryPrice = prices[i]
      const entryTime = new Date(marketData[i].timestamp)

      const tpPrice = signal.direction === "long"
        ? entryPrice * (1 + (config.takeprofit_factor * config.position_cost) / 100)
        : entryPrice * (1 - (config.takeprofit_factor * config.position_cost) / 100)

      const stopLossPercent = resolveStopLossPercent(config.takeprofit_factor, config.stoploss_ratio) * config.position_cost
      const slPrice = signal.direction === "long"
        ? entryPrice * (1 - stopLossPercent / 100)
        : entryPrice * (1 + stopLossPercent / 100)

      let exitPrice = entryPrice
      let exitTime = entryTime
      let exitReason = "timeout"

      for (let j = i + 1; j < Math.min(i + 50, marketData.length); j++) {
        const currentPrice = prices[j]
        const currentTime = new Date(marketData[j].timestamp)

        if (signal.direction === "long") {
          if (currentPrice >= tpPrice) { exitPrice = tpPrice; exitTime = currentTime; exitReason = "takeprofit"; break }
          if (currentPrice <= slPrice) { exitPrice = slPrice; exitTime = currentTime; exitReason = "stoploss"; break }
        } else {
          if (currentPrice <= tpPrice) { exitPrice = tpPrice; exitTime = currentTime; exitReason = "takeprofit"; break }
          if (currentPrice >= slPrice) { exitPrice = slPrice; exitTime = currentTime; exitReason = "stoploss"; break }
        }
      }

      const pnl = signal.direction === "long"
        ? ((exitPrice - entryPrice) / entryPrice) * balance * 0.1
        : ((entryPrice - exitPrice) / entryPrice) * balance * 0.1

      balance += pnl
      equity = balance
      trades.push({ entryPrice, exitPrice, entryTime, exitTime, direction: signal.direction, pnl, exitReason })

      if (equity > maxEquity) {
        maxEquity = equity
        if (drawdownStart) {
          totalDrawdownHours += (new Date().getTime() - drawdownStart.getTime()) / (1000 * 60 * 60)
          drawdownStart = null
        }
      } else {
        const currentDrawdown = ((maxEquity - equity) / maxEquity) * 100
        maxDrawdown = Math.max(maxDrawdown, currentDrawdown)
        if (!drawdownStart) drawdownStart = new Date()
      }
    }

    const winningTrades = trades.filter((t) => t.pnl > 0)
    const losingTrades = trades.filter((t) => t.pnl < 0)
    const totalProfit = winningTrades.reduce((sum, t) => sum + t.pnl, 0)
    const totalLoss = Math.abs(losingTrades.reduce((sum, t) => sum + t.pnl, 0))
    const profitFactor = totalLoss > 0 ? totalProfit / totalLoss : totalProfit > 0 ? 99 : 0
    const winRate = trades.length > 0 ? winningTrades.length / trades.length : 0
    const avgProfit = winningTrades.length > 0 ? totalProfit / winningTrades.length : 0
    const avgLoss = losingTrades.length > 0 ? totalLoss / losingTrades.length : 0

    const returns = trades.map((t) => t.pnl / 10000)
    const avgReturn = returns.length > 0 ? returns.reduce((sum, r) => sum + r, 0) / returns.length : 0
    const variance = returns.length > 0 ? returns.reduce((sum, r) => sum + Math.pow(r - avgReturn, 2), 0) / returns.length : 0
    const sharpeRatio = variance > 0 ? avgReturn / Math.sqrt(variance) : 0

    return {
      configId: config.id, profitFactor, winRate,
      totalTrades: trades.length, winningTrades: winningTrades.length, losingTrades: losingTrades.length,
      avgProfit, avgLoss, maxDrawdown, drawdownHours: totalDrawdownHours, sharpeRatio,
    }
  }

  getResults(): Map<string, TestResult> {
    return this.testResults
  }

  async saveResults(presetId: string): Promise<void> {
    try {
      await initRedis()
      const client = getRedisClient()

      for (const [configId, result] of this.testResults.entries()) {
        const resultKey = `preset_test:${presetId}:${configId}`
        await setSettings(resultKey, {
          ...result,
          preset_id: presetId,
          tested_at: new Date().toISOString(),
        })
        await client.sadd(`preset_tests:${presetId}`, configId)
      }

      console.log(`[v0] Saved ${this.testResults.size} test results to Redis`)
    } catch (error) {
      console.error("[v0] Failed to save test results:", error)
    }
  }
}
