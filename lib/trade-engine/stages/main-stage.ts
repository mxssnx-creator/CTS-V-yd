/**
 * Stage 3: Main Position Evaluation
 * Filter and evaluate base positions, calculate metrics, maintain history and trends
 * Creates subset of base positions that meet evaluation criteria
 */

import { getRedisClient, initRedis } from "@/lib/redis-db"
import type { BasePosition } from "./base-stage"

const LOG_PREFIX = "[v0] [MainPositionStage]"

export interface MainPosition {
  id: string
  connectionId: string
  symbol: string
  direction: "long" | "short"
  entryPrice: number
  basePositionCount: number
  averageStrength: number // Average of all base positions
  trendScore: number // 0-1, based on position history
  volatilityScore: number // 0-1, market volatility
  riskScore: number // 0-1, calculated risk
  timestamp: number
  metrics: {
    successRate: number // % of positions closed profitably
    averageRoi: number // Average ROI of closed positions
    maxDrawdown: number // Max drawdown observed
    consistencyScore: number // Consistency of profitability
  }
  history: {
    last24h: number // Position count in last 24h
    last7d: number // Position count in last 7d
    closedLastHour: number // Closed positions in last hour
    closedLastDay: number // Closed positions in last day
  }
  status: "active" | "paused" | "closed"
}

/**
 * Evaluate base positions and create main position sets
 * Filters base positions by evaluation criteria
 */
export async function evaluateToMainPositions(
  connectionId: string,
  basePositions: BasePosition[],
  config?: {
    minStrengthThreshold?: number // Default 0.5
    trendConfidence?: number // Default 0.6
    maxDrawdownLimit?: number // Default 0.1 (10%)
  }
): Promise<MainPosition[]> {
  await initRedis()
  const client = getRedisClient()
  const mainPositions: MainPosition[] = []

  const minStrength = config?.minStrengthThreshold || 0.5
  const trendConf = config?.trendConfidence || 0.6
  const maxDD = config?.maxDrawdownLimit || 0.1

  console.log(
    `${LOG_PREFIX} Evaluating ${basePositions.length} base positions to main positions`
  )

  try {
    // Group base positions by symbol and direction
    const grouped = groupBySymbolAndDirection(basePositions)

    for (const [key, positions] of Object.entries(grouped)) {
      const [symbol, direction] = key.split(":")

      // Calculate evaluation metrics
      const avgStrength = calculateAverageStrength(positions)
      const trendScore = await calculateTrendScore(client, connectionId, symbol, direction)
      const volatility = await calculateVolatilityScore(
        client,
        connectionId,
        symbol
      )
      const riskScore = calculateRiskScore(positions, maxDD)

      // Check if passes threshold
      if (avgStrength < minStrength) {
        console.log(
          `${LOG_PREFIX} Skipping ${symbol} ${direction} - strength ${avgStrength.toFixed(
            2
          )} < ${minStrength}`
        )
        continue
      }

      // Get historical metrics
      const metrics = await getPositionMetrics(client, connectionId, symbol, direction)
      const history = await getPositionHistory(client, connectionId, symbol, direction)

      const mainPosition: MainPosition = {
        id: `main:${connectionId}:${symbol}:${direction}:${Date.now()}`,
        connectionId,
        symbol,
        direction: direction as "long" | "short",
        entryPrice: positions[0].entryPrice,
        basePositionCount: positions.length,
        averageStrength: avgStrength,
        trendScore,
        volatilityScore: volatility,
        riskScore,
        timestamp: Date.now(),
        metrics,
        history,
        status: "active",
      }

      mainPositions.push(mainPosition)

      // Store main position
      const storageKey = `main:position:${mainPosition.id}`
      await client.setex(storageKey, 604800, JSON.stringify(mainPosition)) // 7 days
      await client.sadd(`main:positions:index:${connectionId}`, mainPosition.id)
      await client.expire(`main:positions:index:${connectionId}`, 604800)

      console.log(
        `${LOG_PREFIX} Created main position: ${symbol} ${direction} (strength=${avgStrength.toFixed(
          2
        )}, trend=${trendScore.toFixed(2)}, vol=${volatility.toFixed(2)})`
      )
    }

    console.log(`${LOG_PREFIX} Evaluated to ${mainPositions.length} main positions`)
    return mainPositions
  } catch (err) {
    console.error(`${LOG_PREFIX} Error evaluating main positions:`, err)
    throw err
  }
}

/**
 * Group base positions by symbol and direction
 */
function groupBySymbolAndDirection(
  positions: BasePosition[]
): Record<string, BasePosition[]> {
  const grouped: Record<string, BasePosition[]> = {}

  for (const position of positions) {
    const key = `${position.symbol}:${position.direction}`
    if (!grouped[key]) {
      grouped[key] = []
    }
    grouped[key].push(position)
  }

  return grouped
}

/**
 * Calculate average strength from base positions
 */
function calculateAverageStrength(positions: BasePosition[]): number {
  if (positions.length === 0) return 0
  const sum = positions.reduce((acc, p) => acc + p.indicationStrength, 0)
  return sum / positions.length
}

/**
 * Calculate trend score based on historical data
 */
async function calculateTrendScore(
  client: any,
  connectionId: string,
  symbol: string,
  direction: string
): Promise<number> {
  try {
    const key = `trend:${connectionId}:${symbol}:${direction}`
    const data = await client.get(key)

    if (!data) return 0.5 // Default neutral if no history

    const trendData = JSON.parse(data)
    const uptrend = trendData.uptrend || 0
    const downtrend = trendData.downtrend || 0
    const total = uptrend + downtrend

    if (total === 0) return 0.5

    const score = direction === "long" ? uptrend / total : downtrend / total
    return Math.min(1, Math.max(0, score))
  } catch {
    return 0.5
  }
}

/**
 * Calculate volatility score for symbol
 */
async function calculateVolatilityScore(
  client: any,
  connectionId: string,
  symbol: string
): Promise<number> {
  try {
    const key = `volatility:${connectionId}:${symbol}`
    const data = await client.get(key)

    if (!data) return 0.5

    const volatilityData = JSON.parse(data)
    return Math.min(1, Math.max(0, volatilityData.score || 0.5))
  } catch {
    return 0.5
  }
}

/**
 * Calculate risk score based on positions
 */
function calculateRiskScore(positions: BasePosition[], maxDrawdown: number): number {
  if (positions.length === 0) return 0

  // Simplified: score based on position entry prices spread
  const prices = positions.map((p) => p.entryPrice)
  const avgPrice =
    prices.reduce((a, b) => a + b, 0) / prices.length
  const maxDeviation = Math.max(
    ...prices.map((p) => Math.abs(p - avgPrice) / avgPrice)
  )

  return maxDrawdown > 0 ? Math.min(1, maxDeviation / maxDrawdown) : 0
}

/**
 * Get position metrics (success rate, ROI, etc.)
 */
async function getPositionMetrics(
  client: any,
  connectionId: string,
  symbol: string,
  direction: string
): Promise<MainPosition["metrics"]> {
  try {
    const key = `metrics:${connectionId}:${symbol}:${direction}`
    const data = await client.get(key)

    if (!data) {
      return {
        successRate: 0.5,
        averageRoi: 0,
        maxDrawdown: 0,
        consistencyScore: 0,
      }
    }

    return JSON.parse(data)
  } catch {
    return {
      successRate: 0.5,
      averageRoi: 0,
      maxDrawdown: 0,
      consistencyScore: 0,
    }
  }
}

/**
 * Get position history
 */
async function getPositionHistory(
  client: any,
  connectionId: string,
  symbol: string,
  direction: string
): Promise<MainPosition["history"]> {
  try {
    const key = `history:${connectionId}:${symbol}:${direction}`
    const data = await client.get(key)

    if (!data) {
      return {
        last24h: 0,
        last7d: 0,
        closedLastHour: 0,
        closedLastDay: 0,
      }
    }

    return JSON.parse(data)
  } catch {
    return {
      last24h: 0,
      last7d: 0,
      closedLastHour: 0,
      closedLastDay: 0,
    }
  }
}

/**
 * Get all main positions for connection
 */
export async function getMainPositions(connectionId: string): Promise<MainPosition[]> {
  await initRedis()
  const client = getRedisClient()

  try {
    const ids = ((await client.smembers(`main:positions:index:${connectionId}`).catch(() => [])) || []) as string[]
    if (ids.length === 0) return []

    // Batch GETs from the explicit index. Avoid Redis KEYS here: this accessor
    // runs in engine/runtime paths and may be polled frequently.
    const rawValues = await Promise.all(
      ids.map((id: string) => client.get(`main:position:${id}`).catch(() => null)),
    )
    const positions: MainPosition[] = []
    for (const data of rawValues) {
      if (!data) continue
      try { positions.push(JSON.parse(data as string)) } catch { /* ignore */ }
    }
    return positions
  } catch (err) {
    console.warn(`${LOG_PREFIX} Error getting main positions:`, err)
    return []
  }
}

/**
 * Update main position metrics
 */
export async function updateMainPositionMetrics(
  connectionId: string,
  symbol: string,
  direction: string,
  metrics: Partial<MainPosition["metrics"]>
): Promise<void> {
  await initRedis()
  const client = getRedisClient()

  try {
    const key = `metrics:${connectionId}:${symbol}:${direction}`
    const existing = await client.get(key)
    const current = existing ? JSON.parse(existing) : {}

    const updated = { ...current, ...metrics }
    await client.setex(key, 604800, JSON.stringify(updated))

    console.log(
      `${LOG_PREFIX} Updated metrics for ${symbol} ${direction}: ${JSON.stringify(metrics)}`
    )
  } catch (err) {
    console.warn(`${LOG_PREFIX} Error updating metrics:`, err)
  }
}

export default {
  evaluateToMainPositions,
  getMainPositions,
  updateMainPositionMetrics,
}
