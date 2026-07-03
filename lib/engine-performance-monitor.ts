/**
 * Engine Performance Monitor
 * Tracks detailed metrics about engine processing cycles, timings, and throughput
 */

import { getRedisClient, initRedis } from "@/lib/redis-db"


async function scanKeys(client: any, pattern: string, limit = 500): Promise<string[]> {
  const keys: string[] = []
  let cursor = "0"
  do {
    const result = await client.scan(cursor, "MATCH", pattern, "COUNT", 100).catch(() => null)
    if (!result) break
    cursor = String(Array.isArray(result) ? result[0] : result.cursor || "0")
    const batch = (Array.isArray(result) ? result[1] : result.keys || []) as string[]
    keys.push(...batch)
  } while (cursor !== "0" && keys.length < limit)
  return keys.slice(0, limit)
}

export interface CycleMetrics {
  cycleNumber: number
  startTime: number
  endTime: number
  durationMs: number
  symbolsProcessed: number
  // `indicationsGenerated` is the total indications produced this
  // cycle; only relevant for the indications processor's metric calls
  // — strategy/realtime metric calls leave it undefined.
  indicationsGenerated?: number
  strategiesEvaluated?: number
  // Strategies that completed evaluation AND signalled "ready to enter
  // live trading" (passed all filters). Tracked separately from
  // strategiesEvaluated so the dashboard can show the "live-ready"
  // conversion rate without re-deriving it from indication counts.
  strategiesLiveReady?: number
  // Cumulative running total across all strategy cycles since engine
  // start — useful for time-series charts that aren't aligned to a
  // particular cycle.
  totalCumulativeStrategies?: number
  errors: number
  timestamp?: string
}

export interface ProcessorMetrics {
  processorName: string
  totalCycles: number
  successfulCycles: number
  failedCycles: number
  avgCycleDurationMs: number
  minCycleDurationMs: number
  maxCycleDurationMs: number
  totalIndications: number
  totalStrategies: number
  totalErrors: number
  lastCycleTime: number
  cyclesPerMinute: number
  throughput: number // items processed per second
}

export interface EngineMetrics {
  connectionId: string
  startTime: number
  indicationMetrics: ProcessorMetrics
  strategyMetrics: ProcessorMetrics
  realtimeMetrics: ProcessorMetrics
  symbols: string[]
  dataSizes: {
    marketDataBytes: number
    indicationSetsBytes: number
    positionDataBytes: number
  }
  parallelProcesses: number
  activeTimers: number
}

class EnginePerformanceMonitor {
  private metrics: Map<string, EngineMetrics> = new Map()
  private cycleHistory: Map<string, CycleMetrics[]> = new Map()
  private readonly MAX_HISTORY = 100

  async trackCycle(
    connectionId: string,
    processorName: "indications" | "strategies" | "realtime",
    metrics: Partial<CycleMetrics>
  ): Promise<void> {
    await initRedis()
    const client = getRedisClient()
    
    const key = `engine_metrics:${connectionId}:${processorName}`
    const cycleKey = `engine_cycles:${connectionId}:${processorName}`
    
    const cycleData: CycleMetrics = {
      cycleNumber: metrics.cycleNumber || 0,
      startTime: metrics.startTime || Date.now(),
      endTime: metrics.endTime || Date.now(),
      durationMs: metrics.durationMs || 0,
      symbolsProcessed: metrics.symbolsProcessed || 0,
      indicationsGenerated: metrics.indicationsGenerated || 0,
      strategiesEvaluated: metrics.strategiesEvaluated || 0,
      errors: metrics.errors || 0,
      timestamp: new Date().toISOString(),
    }

    // Store in Redis for persistence
    await client.lpush(cycleKey, JSON.stringify(cycleData))
    await client.ltrim(cycleKey, 0, this.MAX_HISTORY - 1)
    await client.expire(cycleKey, 86400) // 24h TTL

    // Update aggregated metrics
    const existing = await client.hgetall(key)
    const totalCycles = parseInt(existing?.total_cycles || "0") + 1
    const successfulCycles = parseInt(existing?.successful_cycles || "0") + (cycleData.errors === 0 ? 1 : 0)
    const failedCycles = parseInt(existing?.failed_cycles || "0") + (cycleData.errors > 0 ? 1 : 0)
    
    const totalDuration = parseInt(existing?.total_duration_ms || "0") + cycleData.durationMs
    const avgDuration = Math.round(totalDuration / totalCycles)
    
    const minDuration = Math.min(
      parseInt(existing?.min_duration_ms || "999999"),
      cycleData.durationMs
    )
    const maxDuration = Math.max(
      parseInt(existing?.max_duration_ms || "0"),
      cycleData.durationMs
    )

    const totalIndications = parseInt(existing?.total_indications || "0") + (cycleData.indicationsGenerated || 0)
    const totalStrategies = parseInt(existing?.total_strategies || "0") + (cycleData.strategiesEvaluated || 0)
    const totalErrors = parseInt(existing?.total_errors || "0") + cycleData.errors

    // Calculate cycles per minute
    const now = Date.now()
    const lastMinute = now - 60000
    const recentCycles = (await client.lrange(cycleKey, 0, this.MAX_HISTORY as number))
      .map((c: string) => JSON.parse(c))
      .filter((c: CycleMetrics) => {
        if (!c.timestamp || typeof c.timestamp !== 'string') return false
        return new Date(c.timestamp).getTime() > lastMinute
      })
      .length

    const flatHash: Record<string, string> = {
      processor_name: processorName,
      total_cycles: String(totalCycles),
      successful_cycles: String(successfulCycles),
      failed_cycles: String(failedCycles),
      avg_duration_ms: String(avgDuration),
      min_duration_ms: String(minDuration),
      max_duration_ms: String(maxDuration),
      total_indications: String(totalIndications),
      total_strategies: String(totalStrategies),
      total_errors: String(totalErrors),
      last_cycle_time: new Date().toISOString(),
      cycles_per_minute: String(recentCycles),
      throughput: String(Math.round((totalIndications + totalStrategies) / (totalDuration / 1000) * 100) / 100),
      updated_at: new Date().toISOString(),
    }
    const flatArgs: string[] = []
    for (const [k, v] of Object.entries(flatHash)) {
      flatArgs.push(k, v)
    }
    await client.hmset(key, ...flatArgs)
    await client.expire(key, 86400)
  }

  async getMetrics(connectionId: string, processorName?: string): Promise<any> {
    await initRedis()
    const client = getRedisClient()

    if (processorName) {
      const key = `engine_metrics:${connectionId}:${processorName}`
      const metrics = await client.hgetall(key)
      const cyclesKey = `engine_cycles:${connectionId}:${processorName}`
      const recentCycles = await client.lrange(cyclesKey, 0, 9) // Last 10 cycles
      
      return {
        processor: processorName,
        aggregated: metrics,
        recentCycles: recentCycles.map((c: string) => JSON.parse(c)),
      }
    }

    // Get all processors
    const processors = ["indications", "strategies", "realtime"]
    const allMetrics: Record<string, any> = {}
    
    for (const proc of processors) {
      const key = `engine_metrics:${connectionId}:${proc}`
      const metrics = await client.hgetall(key)
      if (metrics && Object.keys(metrics).length > 0) {
        allMetrics[proc] = metrics
      }
    }

    return allMetrics
  }

  async getDetailedStats(connectionId: string): Promise<any> {
    await initRedis()
    const client = getRedisClient()

    const [indicationMetrics, strategyMetrics, realtimeMetrics] = await Promise.all([
      this.getMetrics(connectionId, "indications"),
      this.getMetrics(connectionId, "strategies"),
      this.getMetrics(connectionId, "realtime"),
    ])

    // Get data sizes
    const dataSizeKeys = await scanKeys(client, `market_data:*`, 50)
    let marketDataBytes = 0
    for (const key of dataSizeKeys.slice(0, 50)) {
      const data = await client.get(key)
      marketDataBytes += data ? data.length : 0
    }

    const indicationKeys = await scanKeys(client, `indication_set:*`, 50)
    let indicationBytes = 0
    for (const key of indicationKeys.slice(0, 50)) {
      const size = await client.scard(key)
      indicationBytes += (size || 0) * 100 // Approximate bytes per indication
    }

    const positionKeys = await scanKeys(client, `pseudo_position:${connectionId}:*`, 1000)
    const positionBytes = positionKeys.length * 500 // Approximate

    // Get symbols
    const engineState = await client.hgetall(`trade_engine_state:${connectionId}`)
    const symbols = engineState?.symbols ? JSON.parse(engineState.symbols) : []

    // Count active timers/processes
    const timerKeys = await scanKeys(client, `timer:*:${connectionId}:*`, 1000)
    const activeTimers = timerKeys.length

    return {
      connectionId,
      timestamp: new Date().toISOString(),
      processors: {
        indications: indicationMetrics,
        strategies: strategyMetrics,
        realtime: realtimeMetrics,
      },
      dataSizes: {
        marketDataBytes,
        marketDataMB: Math.round(marketDataBytes / 1024 / 1024 * 100) / 100,
        indicationSetsBytes: indicationBytes,
        indicationSetsMB: Math.round(indicationBytes / 1024 / 1024 * 100) / 100,
        positionDataBytes: positionBytes,
        positionDataMB: Math.round(positionBytes / 1024 / 1024 * 100) / 100,
        totalMB: Math.round((marketDataBytes + indicationBytes + positionBytes) / 1024 / 1024 * 100) / 100,
      },
      symbols: {
        count: symbols.length,
        list: symbols.slice(0, 20), // First 20
      },
      performance: {
        activeTimers,
        indicationCycles: Math.max(0, parseInt(indicationMetrics?.aggregated?.total_cycles || "0", 10)),
        strategyCycles: Math.max(0, parseInt(strategyMetrics?.aggregated?.total_cycles || "0", 10)),
        realtimeCycles: Math.max(0, parseInt(realtimeMetrics?.aggregated?.total_cycles || "0", 10)),
        totalCycles: 
          Math.max(0, parseInt(indicationMetrics?.aggregated?.total_cycles || "0", 10)) + 
          Math.max(0, parseInt(strategyMetrics?.aggregated?.total_cycles || "0", 10)) +
          Math.max(0, parseInt(realtimeMetrics?.aggregated?.total_cycles || "0", 10)),
        totalIndications: Math.max(0, parseInt(indicationMetrics?.aggregated?.total_indications || "0", 10)),
        totalStrategies: Math.max(0, parseInt(strategyMetrics?.aggregated?.total_strategies || "0", 10)),
        avgCycleTimeMs: Math.round(
          (Math.max(0, parseInt(indicationMetrics?.aggregated?.avg_duration_ms || "0", 10)) +
           Math.max(0, parseInt(strategyMetrics?.aggregated?.avg_duration_ms || "0", 10)) +
           Math.max(0, parseInt(realtimeMetrics?.aggregated?.avg_duration_ms || "0", 10))) / 3
        ),
      },
    }
  }

  async logEngineSummary(connectionId: string): Promise<void> {
    const stats = await this.getDetailedStats(connectionId)
    
    console.log(`\n╔════════════════════════════════════════════════════════════════╗`)
    console.log(`║           ENGINE PERFORMANCE SUMMARY - ${connectionId.slice(0, 20)}`)
    console.log(`╠════════════════════════════════════════════════════════════════╣`)
    console.log(`║ DATA SIZES:`)
    console.log(`║   Market Data:      ${stats.dataSizes.marketDataMB.toFixed(2)} MB (${stats.symbols.count} symbols)`)
    console.log(`║   Indication Sets:  ${stats.dataSizes.indicationSetsMB.toFixed(2)} MB`)
    console.log(`║   Positions:        ${stats.dataSizes.positionDataMB.toFixed(2)} MB`)
    console.log(`║   TOTAL:            ${stats.dataSizes.totalMB.toFixed(2)} MB`)
    console.log(`╠════════════════════════════════════════════════════════════════╣`)
    console.log(`║ PROCESSING CYCLES:`)
    console.log(`║   Indications:      ${stats.performance.indicationCycles.toLocaleString()} cycles`)
    console.log(`║   Strategies:       ${stats.performance.strategyCycles.toLocaleString()} cycles`)
    console.log(`║   Realtime:         ${stats.performance.realtimeCycles.toLocaleString()} cycles`)
    console.log(`║   TOTAL:            ${stats.performance.totalCycles.toLocaleString()} cycles`)
    console.log(`╠════════════════════════════════════════════════════════════════╣`)
    console.log(`║ ITEMS PROCESSED:`)
    console.log(`║   Indications:      ${stats.performance.totalIndications.toLocaleString()}`)
    console.log(`║   Strategies:       ${stats.performance.totalStrategies.toLocaleString()}`)
    console.log(`╠════════════════════════════════════════════════════════════════╣`)
    console.log(`║ PERFORMANCE:`)
    console.log(`║   Avg Cycle Time:   ${stats.performance.avgCycleTimeMs} ms`)
    console.log(`║   Active Timers:    ${stats.performance.activeTimers}`)
    console.log(`╚════════════════════════════════════════════════════════════════╝\n`)
  }
}

export const engineMonitor = new EnginePerformanceMonitor()
