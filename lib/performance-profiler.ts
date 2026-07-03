/**
 * High-frequency cycle performance profiler and optimizer
 * Tracks metrics for indication, strategy, and realtime cycles
 * Identifies bottlenecks and optimizes hot paths
 */

interface CycleMetrics {
  startTime: number
  endTime?: number
  duration?: number
  phase: string
  connectionId: string
  symbol?: string
  operations: Array<{
    name: string
    duration: number
    timestamp: number
  }>
}

interface PerformanceStats {
  totalCycles: number
  avgCycleDuration: number
  maxCycleDuration: number
  minCycleDuration: number
  p95Duration: number
  p99Duration: number
  operationBreakdown: Record<string, { count: number; avgDuration: number }>
  slowCycles: CycleMetrics[]
}

interface OperationTimingRing {
  values: number[]
  nextIndex: number
  count: number
}

export class PerformanceProfiler {
  private cycles: Map<string, CycleMetrics> = new Map()
  private operationTimings: Map<string, OperationTimingRing> = new Map()
  private cycleSeq = 0
  private readonly MAX_HISTORY = 1000
  private readonly MAX_TIMINGS_PER_OP = 1000
  private readonly SLOW_CYCLE_THRESHOLD_MS = 250

  startCycle(connectionId: string, phase: string, symbol?: string): string {
    const cycleId = `${phase}-${connectionId}-${symbol || "all"}-${Date.now()}-${this.cycleSeq++}`
    const metrics: CycleMetrics = {
      startTime: performance.now(),
      phase,
      connectionId,
      symbol,
      operations: [],
    }
    this.cycles.set(cycleId, metrics)
    return cycleId
  }

  recordOperation(cycleId: string, operationName: string): void {
    const cycle = this.cycles.get(cycleId)
    if (!cycle) return

    const now = performance.now()
    const lastOp = cycle.operations[cycle.operations.length - 1]
    const duration = lastOp ? now - lastOp.timestamp : now - cycle.startTime

    cycle.operations.push({
      name: operationName,
      duration,
      timestamp: now,
    })
  }

  endCycle(cycleId: string): CycleMetrics | null {
    const cycle = this.cycles.get(cycleId)
    if (!cycle) return null

    const endTime = performance.now()
    cycle.endTime = endTime
    cycle.duration = endTime - cycle.startTime

    for (const op of cycle.operations) {
      let timings = this.operationTimings.get(op.name)
      if (!timings) {
        timings = {
          values: new Array(this.MAX_TIMINGS_PER_OP),
          nextIndex: 0,
          count: 0,
        }
        this.operationTimings.set(op.name, timings)
      }

      timings.values[timings.nextIndex] = op.duration
      timings.nextIndex = (timings.nextIndex + 1) % this.MAX_TIMINGS_PER_OP
      timings.count = Math.min(timings.count + 1, this.MAX_TIMINGS_PER_OP)
    }

    if (this.cycles.size > this.MAX_HISTORY) {
      const oldestKey = this.cycles.keys().next().value as string | undefined
      if (oldestKey) this.cycles.delete(oldestKey)
    }

    return cycle
  }

  getStats(): PerformanceStats {
    const durations = Array.from(this.cycles.values())
      .filter((c) => c.duration !== undefined)
      .map((c) => c.duration!)
      .sort((a, b) => a - b)

    const percentile = (ratio: number) => {
      if (durations.length === 0) return 0
      return durations[Math.min(durations.length - 1, Math.floor((durations.length - 1) * ratio))] || 0
    }

    const operationBreakdown: Record<string, { count: number; avgDuration: number }> = {}
    for (const [name, timings] of this.operationTimings.entries()) {
      let totalDuration = 0
      for (let i = 0; i < timings.count; i++) {
        totalDuration += timings.values[i] || 0
      }

      const avg = timings.count > 0 ? totalDuration / timings.count : 0
      operationBreakdown[name] = {
        count: timings.count,
        avgDuration: Math.round(avg * 100) / 100,
      }
    }

    const slowCycles = Array.from(this.cycles.values())
      .filter((c) => (c.duration || 0) > this.SLOW_CYCLE_THRESHOLD_MS)
      .sort((a, b) => (b.duration || 0) - (a.duration || 0))
      .slice(0, 10)

    return {
      totalCycles: this.cycles.size,
      avgCycleDuration:
        durations.length > 0
          ? Math.round((durations.reduce((a, b) => a + b, 0) / durations.length) * 100) / 100
          : 0,
      maxCycleDuration: durations.length > 0 ? durations[durations.length - 1] : 0,
      minCycleDuration: durations.length > 0 ? durations[0] : 0,
      p95Duration: percentile(0.95),
      p99Duration: percentile(0.99),
      operationBreakdown,
      slowCycles,
    }
  }

  reset(): void {
    this.cycles.clear()
    this.operationTimings.clear()
  }
}

export const performanceProfiler = new PerformanceProfiler()
