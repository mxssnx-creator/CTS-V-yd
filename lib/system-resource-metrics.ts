import os from "os"

interface ResourceMetricGlobalState {
  __system_resource_metric_sample__?: {
    atMs: number
    cpuUsage: NodeJS.CpuUsage
  }
}

export interface SystemResourceMetrics {
  cpuPercent: number
  memoryPercent: number
  memoryUsedBytes: number
  memoryTotalBytes: number
  heapUsedBytes: number
  heapTotalBytes: number
  rssBytes: number
}

function clampPercent(value: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.max(0, Math.min(100, Math.round(value)))
}

function getCpuPercent(): number {
  const now = Date.now()
  const currentUsage = process.cpuUsage()
  const globals = globalThis as unknown as ResourceMetricGlobalState
  const previous = globals.__system_resource_metric_sample__

  globals.__system_resource_metric_sample__ = {
    atMs: now,
    cpuUsage: currentUsage,
  }

  if (previous && now > previous.atMs) {
    const delta = process.cpuUsage(previous.cpuUsage)
    const elapsedMicros = (now - previous.atMs) * 1000
    const coreCount = Math.max(1, os.cpus()?.length || 1)
    const usedMicros = delta.user + delta.system
    return clampPercent((usedMicros / (elapsedMicros * coreCount)) * 100)
  }

  const uptimeMicros = Math.max(1, process.uptime() * 1_000_000)
  const coreCount = Math.max(1, os.cpus()?.length || 1)
  const lifetimePercent = ((currentUsage.user + currentUsage.system) / (uptimeMicros * coreCount)) * 100
  if (Number.isFinite(lifetimePercent) && lifetimePercent > 0) {
    return clampPercent(lifetimePercent)
  }

  const oneMinuteLoad = os.loadavg?.()[0] ?? 0
  return clampPercent((oneMinuteLoad / coreCount) * 100)
}

export function getSystemResourceMetrics(): SystemResourceMetrics {
  const memory = process.memoryUsage()
  const totalMemory = Math.max(1, os.totalmem?.() || memory.heapTotal || 1)
  // RSS is the real resident process footprint and is more useful in
  // production/serverless dashboards than heap-used alone. If RSS is not
  // available, fall back to heapUsed so the UI never reports a false 0%.
  const processMemoryUsed = Math.max(memory.rss || 0, memory.heapUsed || 0)
  const memoryPercent = clampPercent((processMemoryUsed / totalMemory) * 100)

  return {
    cpuPercent: getCpuPercent(),
    memoryPercent,
    memoryUsedBytes: processMemoryUsed,
    memoryTotalBytes: totalMemory,
    heapUsedBytes: memory.heapUsed,
    heapTotalBytes: memory.heapTotal,
    rssBytes: memory.rss,
  }
}
