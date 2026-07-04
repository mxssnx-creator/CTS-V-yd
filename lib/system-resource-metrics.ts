import fs from "fs"
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

function roundPercent(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 0
  const rounded = Math.round(value * 10) / 10
  // Production containers often run on hosts with many cores / large memory;
  // integer rounding turns small but real load into a misleading 0%.
  return Math.max(0.1, Math.min(100, rounded))
}

function readPositiveNumberFile(path: string): number | null {
  try {
    const raw = fs.readFileSync(path, "utf8").trim()
    if (!raw || raw === "max") return null
    const value = Number(raw)
    return Number.isFinite(value) && value > 0 ? value : null
  } catch {
    return null
  }
}

function getEffectiveCpuCores(): number {
  const hostCores = Math.max(1, os.cpus()?.length || 1)

  try {
    const raw = fs.readFileSync("/sys/fs/cgroup/cpu.max", "utf8").trim()
    const [quotaRaw, periodRaw] = raw.split(/\s+/)
    const quota = quotaRaw === "max" ? Number.NaN : Number(quotaRaw)
    const period = Number(periodRaw)
    if (Number.isFinite(quota) && Number.isFinite(period) && quota > 0 && period > 0) {
      return Math.max(0.1, Math.min(hostCores, quota / period))
    }
  } catch {
    // cgroup v2 not available; try cgroup v1 below.
  }

  const quota = readPositiveNumberFile("/sys/fs/cgroup/cpu/cpu.cfs_quota_us")
  const period = readPositiveNumberFile("/sys/fs/cgroup/cpu/cpu.cfs_period_us")
  if (quota && period) {
    return Math.max(0.1, Math.min(hostCores, quota / period))
  }

  return hostCores
}

function getMemoryLimitBytes(): number {
  const hostTotal = Math.max(1, os.totalmem?.() || 1)
  const cgroupLimit =
    readPositiveNumberFile("/sys/fs/cgroup/memory.max") ??
    readPositiveNumberFile("/sys/fs/cgroup/memory/memory.limit_in_bytes")

  // Some runtimes expose an effectively unlimited cgroup value. Ignore limits
  // larger than host memory and fall back to os.totalmem().
  if (cgroupLimit && cgroupLimit <= hostTotal) return cgroupLimit
  return hostTotal
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

  const effectiveCores = getEffectiveCpuCores()

  if (previous && now > previous.atMs) {
    const delta = process.cpuUsage(previous.cpuUsage)
    const elapsedMicros = (now - previous.atMs) * 1000
    const usedMicros = delta.user + delta.system
    return roundPercent((usedMicros / (elapsedMicros * effectiveCores)) * 100)
  }

  const uptimeMicros = Math.max(1, process.uptime() * 1_000_000)
  const lifetimePercent = ((currentUsage.user + currentUsage.system) / (uptimeMicros * effectiveCores)) * 100
  if (Number.isFinite(lifetimePercent) && lifetimePercent > 0) {
    return roundPercent(lifetimePercent)
  }

  const oneMinuteLoad = os.loadavg?.()[0] ?? 0
  return roundPercent((oneMinuteLoad / effectiveCores) * 100)
}

export function getSystemResourceMetrics(): SystemResourceMetrics {
  const memory = process.memoryUsage()
  const totalMemory = Math.max(1, getMemoryLimitBytes())
  // RSS is the real resident process footprint and is more useful in
  // production/serverless dashboards than heap-used alone. If RSS is not
  // available, fall back to heapUsed so the UI never reports a false 0%.
  const processMemoryUsed = Math.max(memory.rss || 0, memory.heapUsed || 0)
  const memoryPercent = roundPercent((processMemoryUsed / totalMemory) * 100)

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
