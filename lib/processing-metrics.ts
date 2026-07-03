/**
 * Processing Metrics Tracker
 * Comprehensive tracking of all processing phases, data sizes, and evaluation metrics
 * Broadcasts updates via SSE for real-time dashboard visibility
 */

import { getRedisClient, initRedis } from '@/lib/redis-db'
import { getBroadcaster } from '@/lib/event-broadcaster'
import { logProgressionEvent } from '@/lib/engine-progression-logs'

export interface ProcessingMetrics {
  connectionId: string
  timestamp: string
  phases: {
    prehistoric: PhaseMetrics
    realtime: PhaseMetrics
    indication: PhaseMetrics
    strategy: PhaseMetrics
  }
  dataSizes: {
    [symbol: string]: {
      [timeframe: string]: number // data point count
    }
  }
  evaluationCounts: {
    indicationBase: number // base indication evaluations
    indicationMain: number // main indication evaluations
    indicationOptimal: number // optimal indication evaluations
    strategyBase: number // base strategy evaluations
    strategyMain: number // main strategy evaluations
    strategyReal: number // real strategy evaluations
  }
  pseudoPositions: {
    totalCreated: number
    totalEvaluated: number
    currentActive: number
  }
  performanceMetrics: {
    avgCycleDuration: number // ms
    totalProcessingTime: number // ms
    lastUpdate: string
  }
}

export interface PhaseMetrics {
  status: 'idle' | 'running' | 'completed' | 'error'
  cycleCount: number
  itemsProcessed: number
  itemsTotal: number
  progress: number // 0-100
  currentTimeframe: string
  duration: number // ms
  lastUpdate: string
  errors: number
  errorMessage?: string
}

class ProcessingMetricsTracker {
  private connectionId: string
  private metrics: ProcessingMetrics
  private updateInterval: NodeJS.Timeout | null = null
  private lastAccessedAt: number = Date.now()

  constructor(connectionId: string) {
    this.connectionId = connectionId
    this.metrics = this.initializeMetrics()
  }

  private initializeMetrics(): ProcessingMetrics {
    return {
      connectionId: this.connectionId,
      timestamp: new Date().toISOString(),
      phases: {
        prehistoric: this.createPhaseMetrics(),
        realtime: this.createPhaseMetrics(),
        indication: this.createPhaseMetrics(),
        strategy: this.createPhaseMetrics(),
      },
      dataSizes: {},
      evaluationCounts: {
        indicationBase: 0,
        indicationMain: 0,
        indicationOptimal: 0,
        strategyBase: 0,
        strategyMain: 0,
        strategyReal: 0,
      },
      pseudoPositions: {
        totalCreated: 0,
        totalEvaluated: 0,
        currentActive: 0,
      },
      performanceMetrics: {
        avgCycleDuration: 0,
        totalProcessingTime: 0,
        lastUpdate: new Date().toISOString(),
      },
    }
  }

  private touch(): void {
    this.lastAccessedAt = Date.now()
  }

  getLastAccessedAt(): number {
    return this.lastAccessedAt
  }

  private createPhaseMetrics(): PhaseMetrics {
    return {
      status: 'idle',
      cycleCount: 0,
      itemsProcessed: 0,
      itemsTotal: 0,
      progress: 0,
      currentTimeframe: '1m',
      duration: 0,
      lastUpdate: new Date().toISOString(),
      errors: 0,
    }
  }

  /**
   * Record phase start
   */
  recordPhaseStart(
    phase: 'prehistoric' | 'realtime' | 'indication' | 'strategy',
    itemsTotal: number,
    timeframe: string = '1m'
  ): void {
    this.touch()
    const phaseMetrics = this.metrics.phases[phase]
    phaseMetrics.status = 'running'
    phaseMetrics.itemsProcessed = 0
    phaseMetrics.itemsTotal = itemsTotal
    phaseMetrics.currentTimeframe = timeframe
    phaseMetrics.progress = 0
    phaseMetrics.lastUpdate = new Date().toISOString()
    this.broadcastMetricsUpdate(phase)
  }

  /**
   * Record phase progress
   */
  recordPhaseProgress(
    phase: 'prehistoric' | 'realtime' | 'indication' | 'strategy',
    itemsProcessed: number,
    totalDuration: number = 0
  ): void {
    this.touch()
    const phaseMetrics = this.metrics.phases[phase]
    phaseMetrics.itemsProcessed = itemsProcessed
    phaseMetrics.progress = phaseMetrics.itemsTotal > 0 ? (itemsProcessed / phaseMetrics.itemsTotal) * 100 : 0
    phaseMetrics.duration = totalDuration
    phaseMetrics.lastUpdate = new Date().toISOString()
    this.broadcastMetricsUpdate(phase)
  }

  /**
   * Record phase completion
   */
  recordPhaseCompletion(phase: 'prehistoric' | 'realtime' | 'indication' | 'strategy', duration: number): void {
    this.touch()
    const phaseMetrics = this.metrics.phases[phase]
    phaseMetrics.status = 'completed'
    phaseMetrics.cycleCount += 1
    phaseMetrics.progress = 100
    phaseMetrics.duration = duration
    phaseMetrics.lastUpdate = new Date().toISOString()
    this.broadcastMetricsUpdate(phase)
  }

  /**
   * Record phase error
   */
  recordPhaseError(phase: 'prehistoric' | 'realtime' | 'indication' | 'strategy', error: string): void {
    this.touch()
    const phaseMetrics = this.metrics.phases[phase]
    phaseMetrics.status = 'error'
    phaseMetrics.errors += 1
    phaseMetrics.errorMessage = error
    phaseMetrics.lastUpdate = new Date().toISOString()
    this.broadcastMetricsUpdate(phase)
  }

  /**
   * Record data size for symbol and timeframe
   */
  recordDataSize(symbol: string, timeframe: string, count: number): void {
    this.touch()
    if (!this.metrics.dataSizes[symbol]) {
      this.metrics.dataSizes[symbol] = {}
    }
    this.metrics.dataSizes[symbol][timeframe] = count
  }

  /**
   * Increment evaluation count
   */
  incrementEvaluationCount(type: keyof ProcessingMetrics['evaluationCounts']): void {
    this.touch()
    this.metrics.evaluationCounts[type] += 1
  }

  /**
   * Update pseudo position metrics
   */
  updatePseudoPositionMetrics(created: number, evaluated: number, active: number): void {
    this.touch()
    this.metrics.pseudoPositions.totalCreated += created
    this.metrics.pseudoPositions.totalEvaluated += evaluated
    this.metrics.pseudoPositions.currentActive = active
  }

  /**
   * Update performance metrics
   */
  updatePerformanceMetrics(cycleDuration: number): void {
    this.touch()
    const totalTime = this.metrics.performanceMetrics.totalProcessingTime || 0
    const cycleCount = Object.values(this.metrics.phases).reduce((sum, p) => sum + p.cycleCount, 0)

    if (cycleCount > 0) {
      this.metrics.performanceMetrics.avgCycleDuration = (totalTime + cycleDuration) / cycleCount
      this.metrics.performanceMetrics.totalProcessingTime += cycleDuration
    } else {
      this.metrics.performanceMetrics.avgCycleDuration = cycleDuration
      this.metrics.performanceMetrics.totalProcessingTime = cycleDuration
    }

    this.metrics.performanceMetrics.lastUpdate = new Date().toISOString()
  }

  /**
   * Get current metrics
   */
  getMetrics(): ProcessingMetrics {
    this.touch()
    return {
      ...this.metrics,
      timestamp: new Date().toISOString(),
    }
  }

  /**
   * Get metrics summary for logging
   */
  getMetricsSummary(): string {
    this.touch()
    const m = this.metrics
    const phases = Object.entries(m.phases)
      .map(([name, phase]) => `${name}: ${phase.cycleCount} cycles, ${phase.itemsProcessed}/${phase.itemsTotal} items`)
      .join(' | ')

    const evals = Object.entries(m.evaluationCounts)
      .filter(([_, count]) => count > 0)
      .map(([type, count]) => `${type}: ${count}`)
      .join(', ')

    return `Processing Metrics: ${phases} | Evaluations: ${evals} | Positions: ${m.pseudoPositions.currentActive} active | Avg cycle: ${m.performanceMetrics.avgCycleDuration.toFixed(0)}ms`
  }

  /**
   * Save metrics to Redis for persistence
   */
  async saveMetrics(): Promise<void> {
    try {
      await initRedis()
      const client = getRedisClient()
      const key = `processing_metrics:${this.connectionId}`
      await client.setex(key, 86400, JSON.stringify(this.metrics)) // 24 hour expiry
    } catch (error) {
      console.error('[ProcessingMetrics] Failed to save metrics:', error)
    }
  }

  /**
   * Broadcast metrics update via SSE
   */
  private broadcastMetricsUpdate(phase: string): void {
    try {
      const broadcaster = getBroadcaster()
      broadcaster.broadcastProcessingProgress(this.connectionId, {
        phase,
        progress: this.metrics.phases[phase as keyof typeof this.metrics.phases].progress,
        itemsProcessed: this.metrics.phases[phase as keyof typeof this.metrics.phases].itemsProcessed,
        totalItems: this.metrics.phases[phase as keyof typeof this.metrics.phases].itemsTotal,
        currentTimeframe: this.metrics.phases[phase as keyof typeof this.metrics.phases].currentTimeframe,
        estimatedTimeRemaining: this.estimateTimeRemaining(phase),
      })
    } catch (error) {
      console.error('[ProcessingMetrics] Failed to broadcast update:', error)
    }
  }

  /**
   * Estimate remaining time based on current progress
   */
  private estimateTimeRemaining(phase: string): number {
    const phaseMetrics = this.metrics.phases[phase as keyof typeof this.metrics.phases]
    if (phaseMetrics.progress >= 100 || phaseMetrics.progress === 0) return 0

    const avgTimePerItem = phaseMetrics.duration / (phaseMetrics.itemsProcessed || 1)
    const itemsRemaining = phaseMetrics.itemsTotal - phaseMetrics.itemsProcessed
    return Math.ceil((itemsRemaining * avgTimePerItem) / 1000) // seconds
  }

  /**
   * Start periodic metrics persistence
   */
  startMetricsPersistence(intervalMs: number = 30000): void {
    if (this.updateInterval) {
      clearInterval(this.updateInterval)
    }

    this.updateInterval = setInterval(async () => {
      await this.saveMetrics()
    }, intervalMs)

    this.updateInterval.unref?.() // Allow process to exit
  }

  /**
   * Stop metrics persistence
   */
  stopMetricsPersistence(): void {
    if (this.updateInterval) {
      clearInterval(this.updateInterval)
      this.updateInterval = null
    }
  }

  /**
   * Reset metrics
   */
  reset(): void {
    this.touch()
    this.metrics = this.initializeMetrics()
  }
}

// Global trackers per connection
const trackers = new Map<string, ProcessingMetricsTracker>()

const DEFAULT_TRACKER_IDLE_TTL_MS = 60 * 60 * 1000
const DEFAULT_TRACKER_CLEANUP_LIMIT = 100
const TRACKER_CLEANUP_INTERVAL_MS = 60 * 1000
let lastTrackerCleanupAt = 0

function getConfiguredTrackerIdleTtlMs(): number {
  const ttlMs = Number(process.env.PROCESSING_METRICS_TRACKER_IDLE_TTL_MS)
  return Number.isFinite(ttlMs) && ttlMs > 0 ? ttlMs : DEFAULT_TRACKER_IDLE_TTL_MS
}

export function cleanupIdleMetricsTrackers(
  ttlMs: number = getConfiguredTrackerIdleTtlMs(),
  maxToCleanup: number = DEFAULT_TRACKER_CLEANUP_LIMIT
): number {
  if (ttlMs <= 0 || maxToCleanup <= 0) return 0

  const cutoff = Date.now() - ttlMs
  let cleaned = 0

  for (const [connectionId, tracker] of trackers) {
    if (cleaned >= maxToCleanup) break
    if (tracker.getLastAccessedAt() > cutoff) continue

    tracker.stopMetricsPersistence()
    trackers.delete(connectionId)
    cleaned += 1
  }

  return cleaned
}

function cleanupIdleMetricsTrackersIfDue(): void {
  const now = Date.now()
  if (now - lastTrackerCleanupAt < TRACKER_CLEANUP_INTERVAL_MS) return

  lastTrackerCleanupAt = now
  cleanupIdleMetricsTrackers()
}

export function getMetricsTracker(connectionId: string): ProcessingMetricsTracker {
  if (!trackers.has(connectionId)) {
    cleanupIdleMetricsTrackersIfDue()
    const tracker = new ProcessingMetricsTracker(connectionId)
    tracker.startMetricsPersistence()
    trackers.set(connectionId, tracker)
  }
  return trackers.get(connectionId)!
}

export function removeMetricsTracker(connectionId: string): void {
  const tracker = trackers.get(connectionId)
  if (tracker) {
    tracker.stopMetricsPersistence()
    trackers.delete(connectionId)
  }
}
