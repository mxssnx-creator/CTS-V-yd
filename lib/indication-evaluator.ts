/**
 * Indication Evaluator
 * Type-based evaluation counting and metrics tracking for all indication types
 */

import { getRedisClient, getSettings, setSettings } from "@/lib/redis-db"
import { EngineProgressManager, getProgressManager } from "./engine-progress-manager"

export interface IndicationResult {
  id: string
  type: string
  symbol: string
  timestamp: string
  value: number
  confidence: number
  strength: number
  passed: boolean
  direction: 'up' | 'down' | 'neutral'
  parameters: Record<string, any>
}

export interface IndicationTypeStats {
  type: string
  totalEvaluations: number
  passed: number
  failed: number
  passRate: number
  avgConfidence: number
  avgStrength: number
  avgValue: number
  lastEvaluated: string | null
  symbols: Record<string, number> // symbol -> count
}

export class IndicationEvaluator {
  private connectionId: string
  private progressManager: EngineProgressManager
  private typeStats: Map<string, IndicationTypeStats> = new Map()

  constructor(connectionId: string) {
    this.connectionId = connectionId
    this.progressManager = getProgressManager(connectionId)
  }

  /**
   * Evaluate an indication and track metrics
   */
  async evaluateIndication(indication: IndicationResult): Promise<void> {
    // Update type stats
    this.updateTypeStats(indication)
    
    // Store in Redis
    await this.storeIndication(indication)
    
    // Update progress manager
    await this.progressManager.updateIndicationMetrics(
      indication.type,
      indication.passed,
      indication.confidence,
      indication.strength
    )
    
    // Log evaluation
    await this.progressManager.incrementIndicationCycle(indication.symbol)
  }

  /**
   * Evaluate multiple indications in batch (parallel).
   *
   * Each indication's evaluate path is fully independent at the data
   * layer:
   *   - `updateTypeStats` is an in-memory Map mutation (instantaneous)
   *   - `storeIndication` writes a per-indication Redis key (no shared
   *     row)
   *   - `updateIndicationMetrics` / `incrementIndicationCycle` are
   *     atomic HINCRBY operations on per-type / per-symbol fields
   *
   * The original implementation looped sequentially with `await` inside
   * `for ... for ...`, serialising every Redis round-trip. On a
   * 200-symbol watchlist with ~6 indication types this was the dominant
   * cost in the indication stage (~1.2 s per cycle). Fanning out via
   * `Promise.all` lets the Redis client pipeline the writes — the
   * client services these in constant time and the engine-manager's
   * per-symbol concurrency cap (16) bounds the global fan-out.
   *
   * Type grouping is retained for downstream observability (callers may
   * inspect `typeStats` after the batch), but it no longer gates
   * concurrency.
   */
  async evaluateBatch(indications: IndicationResult[]): Promise<void> {
    if (indications.length === 0) return
    // Synchronous in-memory updates first — keeps the Map mutations
    // ordered (deterministic typeStats irrespective of write timing).
    for (const ind of indications) this.updateTypeStats(ind)
    // Fan out the I/O. Failures on individual indications must not
    // poison the whole batch — wrap each promise in a catch so
    // Promise.all resolves.
    await Promise.all(
      indications.map((ind) =>
        Promise.all([
          this.storeIndication(ind).catch((err) =>
            console.warn(`[v0] [IndicationEvaluator] storeIndication(${ind.id}) failed:`, err),
          ),
          this.progressManager
            .updateIndicationMetrics(ind.type, ind.passed, ind.confidence, ind.strength)
            .catch((err) =>
              console.warn(`[v0] [IndicationEvaluator] updateIndicationMetrics(${ind.id}) failed:`, err),
            ),
          this.progressManager
            .incrementIndicationCycle(ind.symbol)
            .catch((err) =>
              console.warn(`[v0] [IndicationEvaluator] incrementIndicationCycle(${ind.symbol}) failed:`, err),
            ),
        ]),
      ),
    )
  }

  /**
   * Get statistics for a specific indication type
   */
  getTypeStats(type: string): IndicationTypeStats | undefined {
    return this.typeStats.get(type)
  }

  /**
   * Get all type statistics
   */
  getAllTypeStats(): Map<string, IndicationTypeStats> {
    return this.typeStats
  }

  /**
   * Get summary statistics
   */
  getSummary(): {
    totalEvaluations: number
    typesTracked: number
    overallPassRate: number
    avgConfidence: number
    avgStrength: number
    typeBreakdown: Array<{
      type: string
      evaluations: number
      passed: number
      passRate: number
      avgConfidence: number
      avgStrength: number
    }>
  } {
    let totalEvaluations = 0
    let totalPassed = 0
    let totalConfidence = 0
    let totalStrength = 0

    const typeBreakdown: Array<{
      type: string
      evaluations: number
      passed: number
      passRate: number
      avgConfidence: number
      avgStrength: number
    }> = []

    for (const [type, stats] of this.typeStats) {
      totalEvaluations += stats.totalEvaluations
      totalPassed += stats.passed
      totalConfidence += stats.avgConfidence * stats.totalEvaluations
      totalStrength += stats.avgStrength * stats.totalEvaluations

      typeBreakdown.push({
        type,
        evaluations: stats.totalEvaluations,
        passed: stats.passed,
        passRate: stats.passRate,
        avgConfidence: stats.avgConfidence,
        avgStrength: stats.avgStrength,
      })
    }

    return {
      totalEvaluations,
      typesTracked: this.typeStats.size,
      overallPassRate: totalEvaluations > 0 ? (totalPassed / totalEvaluations) * 100 : 0,
      avgConfidence: totalEvaluations > 0 ? totalConfidence / totalEvaluations : 0,
      avgStrength: totalEvaluations > 0 ? totalStrength / totalEvaluations : 0,
      typeBreakdown,
    }
  }

  /**
   * Update type statistics for an indication
   */
  private updateTypeStats(indication: IndicationResult): void {
    if (!this.typeStats.has(indication.type)) {
      this.typeStats.set(indication.type, {
        type: indication.type,
        totalEvaluations: 0,
        passed: 0,
        failed: 0,
        passRate: 0,
        avgConfidence: 0,
        avgStrength: 0,
        avgValue: 0,
        lastEvaluated: null,
        symbols: {},
      })
    }

    const stats = this.typeStats.get(indication.type)!
    stats.totalEvaluations++
    if (indication.passed) {
      stats.passed++
    } else {
      stats.failed++
    }
    stats.passRate = (stats.passed / stats.totalEvaluations) * 100
    stats.avgConfidence = ((stats.avgConfidence * (stats.totalEvaluations - 1)) + indication.confidence) / stats.totalEvaluations
    stats.avgStrength = ((stats.avgStrength * (stats.totalEvaluations - 1)) + indication.strength) / stats.totalEvaluations
    stats.avgValue = ((stats.avgValue * (stats.totalEvaluations - 1)) + indication.value) / stats.totalEvaluations
    stats.lastEvaluated = indication.timestamp

    if (!stats.symbols[indication.symbol]) {
      stats.symbols[indication.symbol] = 0
    }
    stats.symbols[indication.symbol]++
  }

  /**
   * Store indication in Redis.
   *
   * All writes for one indication are issued via a single MULTI/EXEC
   * pipeline — 5 round-trips collapsed to 1. Previously each lpush,
   * ltrim, and set was a separate await, serialising 5 TCP round-trips
   * per indication. With pipeline they are sent in a single flush and
   * the server processes them atomically.
   */
  private async storeIndication(indication: IndicationResult): Promise<void> {
    try {
      const client = getRedisClient()
      const payload = JSON.stringify(indication)
      const typeKey   = `indications:${this.connectionId}:${indication.type}`
      const symbolKey = `indications:${this.connectionId}:${indication.symbol}`
      const latestKey = `indications:${this.connectionId}:latest:${indication.type}`

      const pipe = client.multi()
      pipe.lpush(typeKey,   payload)
      pipe.ltrim(typeKey,   0, 999)   // Keep last 1000 per type
      pipe.lpush(symbolKey, payload)
      pipe.ltrim(symbolKey, 0, 499)   // Keep last 500 per symbol
      pipe.set(latestKey,   payload, { EX: 3600 })
      await pipe.exec()
    } catch (error) {
      await this.progressManager.addError(
        'indication_store',
        error instanceof Error ? error.message : 'Failed to store indication',
        indication.symbol,
      )
    }
  }

  /**
   * Get recent indications by type
   */
  async getRecentByType(type: string, limit: number = 50): Promise<IndicationResult[]> {
    try {
      const client = getRedisClient()
      const key = `indications:${this.connectionId}:${type}`
      const data = await client.lrange(key, 0, limit - 1)
      return data.map(d => JSON.parse(d as string))
    } catch (error) {
      return []
    }
  }

  /**
   * Get recent indications by symbol
   */
  async getRecentBySymbol(symbol: string, limit: number = 50): Promise<IndicationResult[]> {
    try {
      const client = getRedisClient()
      const key = `indications:${this.connectionId}:${symbol}`
      const data = await client.lrange(key, 0, limit - 1)
      return data.map(d => JSON.parse(d as string))
    } catch (error) {
      return []
    }
  }

  /**
   * Reset all statistics
   */
  reset(): void {
    this.typeStats.clear()
  }
}
