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

class PerformanceProfiler {
  private cycles: Map<string, CycleMetrics> = new Map()
  private operationTimings: Map<string, number[]> = new Map()
  private readonly MAX_HISTORY = 1000
  private readonly SLOW_CYCLE_THRESHOLD_MS = 250 // 300ms default - 250ms = 50ms buffer

  startCycle(connectionId: string, phase: string, symbol?: string): string {
    const cycleId = `${phase}-${connectionId}-${symbol || "all"}-${Date.now()}`
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
    const duration = lastOp ? now - lastOp.timestamp : 0

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

    // Track operation timings with bounded history per operation
    const MAX_TIMINGS_PER_OP = 1000
    for (const op of cycle.operations) {
      if (!this.operationTimings.has(op.name)) {
        this.operationTimings.set(op.name, [])
      }
      const timings = this.operationTimings.get(op.name)!
      timings.push(op.duration)
      // Keep only last 1000 entries per operation to prevent memory explosion
      if (timings.length > MAX_TIMINGS_PER_OP) {
        timings.shift()
      }
    }

    // Cleanup old cycles to prevent memory bloat
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

    const p95Index = Math.floor(durations.length * 0.95)
    const p99Index = Math.floor(durations.length * 0.99)

    const operationBreakdown: Record<string, { count: number; avgDuration: number }> = {}
    for (const [name, timings] of this.operationTimings.entries()) {
      const avg = timings.reduce((a, b) => a + b, 0) / timings.length
      operationBreakdown[name] = {
        count: timings.length,
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
      p95Duration: durations.length > 0 ? durations[p95Index] || 0 : 0,
      p99Duration: durations.length > 0 ? durations[p99Index] || 0 : 0,
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
