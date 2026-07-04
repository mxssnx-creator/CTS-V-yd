/**
 * Memory Management Module
 * Monitors and controls memory usage to prevent leaks during long-term trading
 */

import { performance } from "perf_hooks"

interface MemorySnapshot {
  timestamp: number
  heapUsed: number
  heapTotal: number
  rss: number
  external: number
}

class MemoryManager {
  private static instance: MemoryManager
  private snapshots: MemorySnapshot[] = []
  private gcInterval: NodeJS.Timer | null = null
  private maxHeapMB = 1024
  private warningThreshold = 0.85

  private constructor() {}

  static getInstance(): MemoryManager {
    if (!MemoryManager.instance) {
      MemoryManager.instance = new MemoryManager()
    }
    return MemoryManager.instance
  }

  /**
   * Initialize memory monitoring and GC management
   */
  initialize(maxHeapMB: number = 1024) {
    this.maxHeapMB = maxHeapMB

    // Force GC every 5 minutes
    this.gcInterval = setInterval(() => {
      this.checkAndGC()
    }, 5 * 60 * 1000)

    // Mark interval as non-blocking
    if (typeof (this.gcInterval as any).unref === "function") {
      try {
        (this.gcInterval as any).unref()
      } catch (e) {}
    }

    console.log(`[v0] [Memory] Manager initialized (max: ${maxHeapMB}MB, warning: ${Math.round(this.warningThreshold * 100)}%)`)
  }

  /**
   * Get current memory usage
   */
  getUsage() {
    const mem = process.memoryUsage()
    return {
      heapUsed: Math.round(mem.heapUsed / 1024 / 1024),
      heapTotal: Math.round(mem.heapTotal / 1024 / 1024),
      rss: Math.round(mem.rss / 1024 / 1024),
      external: Math.round(mem.external / 1024 / 1024),
      percentUsed: Math.round((mem.heapUsed / mem.heapTotal) * 100),
    }
  }

  /**
   * Check memory and trigger GC if needed
   */
  private checkAndGC() {
    const usage = this.getUsage()
    const warningLevel = Math.round(this.maxHeapMB * this.warningThreshold)

    if (usage.heapUsed > warningLevel) {
      console.log(`[v0] [Memory] WARNING: High memory usage (${usage.heapUsed}MB / ${this.maxHeapMB}MB)`)

      if (global.gc) {
        try {
          global.gc()
          const afterGC = this.getUsage()
          const freed = usage.heapUsed - afterGC.heapUsed
          console.log(`[v0] [Memory] GC executed, freed ${freed}MB`)
        } catch (e) {
          console.warn(`[v0] [Memory] GC error:`, e)
        }
      } else {
        console.log(`[v0] [Memory] Tip: Run with --expose-gc to enable manual GC`)
      }
    }

    // Record snapshot
    this.snapshots.push({
      timestamp: Date.now(),
      heapUsed: usage.heapUsed,
      heapTotal: usage.heapTotal,
      rss: usage.rss,
      external: usage.external,
    })

    // Keep only last 100 snapshots (5 hours of data at 5-min intervals)
    if (this.snapshots.length > 100) {
      this.snapshots = this.snapshots.slice(-100)
    }
  }

  /**
   * Get memory trend (is it growing?)
   */
  getTrend(): { direction: "stable" | "growing" | "declining"; rate: number } {
    if (this.snapshots.length < 10) {
      return { direction: "stable", rate: 0 }
    }

    const recent = this.snapshots.slice(-10)
    const first = recent[0]
    const last = recent[recent.length - 1]
    const timeDelta = last.timestamp - first.timestamp
    const memoryDelta = last.heapUsed - first.heapUsed
    const rate = timeDelta > 0 ? memoryDelta / (timeDelta / 60000) : 0 // MB per minute

    let direction: "stable" | "growing" | "declining" = "stable"
    if (Math.abs(rate) > 5) {
      direction = rate > 0 ? "growing" : "declining"
    }

    return { direction, rate: Math.round(rate * 10) / 10 }
  }

  /**
   * Clean up
   */
  destroy() {
    if (this.gcInterval) {
      clearInterval(this.gcInterval as any)
      this.gcInterval = null
    }
  }
}

export const getMemoryManager = () => MemoryManager.getInstance()
export const initMemoryManager = (maxHeapMB?: number) => MemoryManager.getInstance().initialize(maxHeapMB)
