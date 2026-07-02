/**
 * Engine Progression Logs - Stores detailed logs of all engine operations
 * Uses simple Redis lists (not sorted sets) for compatibility with Upstash
 */

import { getRedisClient } from "@/lib/redis-db"

export interface ProgressionLogEntry {
  timestamp: string
  level: "info" | "warning" | "error" | "debug"
  phase: string
  message: string
  details?: Record<string, any>
  connectionId: string
}

const LOG_RETENTION_HOURS = 24
const MAX_LOGS_PER_CONNECTION = 500

// In-memory buffer for batch logging (reduces Redis writes significantly).
//
// HMR SAFETY: in Next.js dev mode every save hot-reloads the module,
// which would leak a fresh `setInterval` on every reload if state were
// kept in plain module-scoped `let`s. We pin the buffer and timer on
// `globalThis` so they survive reloads, and we clear any pre-existing
// timer before scheduling a new one.
type ProgressionGlobals = {
  logBuffer?: Map<string, string[]>
  flushTimer?: NodeJS.Timeout | null
  flushTimerStarted?: boolean
}
const g = globalThis as unknown as { __v0_progression?: ProgressionGlobals }
if (!g.__v0_progression) g.__v0_progression = {}
const PG = g.__v0_progression

const logBuffer: Map<string, string[]> =
  PG.logBuffer ?? (PG.logBuffer = new Map<string, string[]>())
const BUFFER_FLUSH_SIZE = 25 // Flush every 25 logs to reduce Redis write pressure
const BUFFER_FLUSH_INTERVAL = 3000 // Or every 3 seconds
const MAX_BUFFER_PER_KEY = 250
const LOG_FLUSH_TIMEOUT_MS = 300

// Important phases that should flush immediately
const IMMEDIATE_FLUSH_PHASES = [
  "initializing", "prehistoric_data", "indications", "strategies", 
  "realtime", "live_trading", "error", "engine_started", "engine_stopped",
  "engine_starting", "engine_error", "quickstart"
]

/**
 * Log a progression event for a connection
 * OPTIMIZED: Uses in-memory buffering with immediate flush for important events
 */
export async function logProgressionEvent(
  connectionId: string,
  phase: string,
  level: "info" | "warning" | "error" | "debug",
  message: string,
  details?: Record<string, any>
): Promise<void> {
  try {
    const timestamp = new Date().toISOString()
    const logKey = `engine_logs:${connectionId}`
    
    // Format: "timestamp|level|phase|message|details_json"
    const logEntry = `${timestamp}|${level}|${phase}|${message}|${JSON.stringify(details || {})}`
    
    // Add to buffer instead of writing immediately
    if (!logBuffer.has(logKey)) {
      logBuffer.set(logKey, [])
    }
    const buffer = logBuffer.get(logKey)!
    buffer.push(logEntry)
    if (buffer.length > MAX_BUFFER_PER_KEY) {
      buffer.splice(0, buffer.length - MAX_BUFFER_PER_KEY)
    }
    
    // Start flush timer if not started. The `PG.flushTimerStarted`
    // flag is keyed on globalThis so HMR module reloads don't spawn
    // duplicate timers; if a stale timer somehow survives in
    // `PG.flushTimer`, clear it before installing the new one.
    if (!PG.flushTimerStarted) {
      if (PG.flushTimer) {
        clearInterval(PG.flushTimer)
      }
      PG.flushTimerStarted = true
      PG.flushTimer = setInterval(flushAllLogBuffers, BUFFER_FLUSH_INTERVAL)
      // Avoid preventing process exit in scripts/tests.
      PG.flushTimer.unref?.()
    }
    
    // Immediate flush for important phases or errors
    const isImportant = IMMEDIATE_FLUSH_PHASES.some(p => phase.includes(p)) || level === "error" || level === "warning"
    if (isImportant || buffer.length >= BUFFER_FLUSH_SIZE) {
      // Never let Redis logging latency block live trading/progression. The
      // periodic flush remains the durability safety net.
      void flushLogBuffer(logKey)
    }

    // Console log for important events (info for important phases, always for errors/warnings)
    if (level === "error" || level === "warning" || isImportant) {
      console.log(`[v0] [${level.toUpperCase()}] [${phase}] ${message}`, details ? JSON.stringify(details).slice(0, 200) : "")
    }
  } catch (error) {
    // Silent fail - logging should never block main operations
    console.error("[v0] [LogError] Failed to log:", error)
  }
}

/**
 * Flush log buffer for a specific key
 */
async function flushLogBuffer(logKey: string): Promise<void> {
  const buffer = logBuffer.get(logKey)
  if (!buffer || buffer.length === 0) return
  
  // Copy and clear buffer immediately to prevent duplicate writes
  const toFlush = [...buffer]
  logBuffer.set(logKey, [])
  
  try {
    const client = getRedisClient()
    
    // ── Progression logs should appear in chronological order ──────────
    // We use lpush to prepend to a Redis list (lpush prepends to the
    // head; lrange returns from head to tail). Without reversing the
    // entries, the FIRST entry in toFlush becomes the HEAD (index 0),
    // so lrange(0, MAX) returns them in chronological order as written.
    //
    // Previously we did `lpush(...toFlush.reverse())` which reversed
    // the order, making lrange read them backwards. The reader at line
    // 158 does NOT reverse, so logs appeared in reverse chronological
    // order. Removing the .reverse() here fixes the bug — logs now
    // display oldest first.
    await Promise.race([
      (async () => {
        await client.lpush(logKey, ...toFlush)
        await client.ltrim(logKey, 0, MAX_LOGS_PER_CONNECTION - 1)
      })(),
      new Promise((_, reject) => setTimeout(() => reject(new Error("progression log flush timeout")), LOG_FLUSH_TIMEOUT_MS)),
    ])
  } catch (error) {
    // Put entries back if flush failed
    const currentBuffer = logBuffer.get(logKey) || []
    const merged = [...toFlush.slice(-100), ...currentBuffer]
    logBuffer.set(logKey, merged.slice(-MAX_BUFFER_PER_KEY))
  }
}

/**
 * Flush all log buffers
 */
export async function flushAllLogBuffers(): Promise<void> {
  const keys = Array.from(logBuffer.keys())
  await Promise.all(keys.map(key => flushLogBuffer(key).catch(() => {})))
}

/**
 * Force flush logs for a specific connection
 */
export async function forceFlushLogs(connectionId: string): Promise<void> {
  const logKey = `engine_logs:${connectionId}`
  await flushLogBuffer(logKey)
}

/**
 * Get all progression logs for a connection
 * OPTIMIZED: Uses native Redis list operations and forces flush first
 */
export async function getProgressionLogs(connectionId: string): Promise<ProgressionLogEntry[]> {
  try {
    // Force flush all pending logs first to ensure we get the latest entries
    await flushAllLogBuffers()
    
    const client = getRedisClient()
    const logKey = `engine_logs:${connectionId}`

    // Use lrange for efficient list retrieval
    const logs = await client.lrange(logKey, 0, MAX_LOGS_PER_CONNECTION - 1)
    if (!logs || logs.length === 0) return []

    // Parse each log entry from "timestamp|level|phase|message|details_json"
    return logs
      .map((entry) => {
        try {
          const parts = entry.split("|")
          if (parts.length < 4) return null
          
          const [timestamp, level, phase, message, ...detailsParts] = parts
          const detailsJson = detailsParts.join("|") // Rejoin in case details contained |
          let details: Record<string, any> = {}
          try {
            details = JSON.parse(detailsJson || "{}")
          } catch {
            details = {}
          }
          
          return {
            timestamp,
            level: (level as any) || "info",
            phase,
            message,
            details,
            connectionId,
          } as ProgressionLogEntry
        } catch {
          return null
        }
      })
      .filter((entry): entry is ProgressionLogEntry => entry !== null)
  } catch (error) {
    console.error("[v0] [EngineLog] Failed to retrieve logs:", error instanceof Error ? error.message : String(error))
    return []
  }
}

/**
 * Clear logs for a connection
 */
export async function clearProgressionLogs(connectionId: string): Promise<void> {
  try {
    const client = getRedisClient()
    const logKey = `engine_logs:${connectionId}`
    await client.del(logKey)
  } catch (error) {
    console.error("[v0] [EngineLog] Failed to clear logs:", error instanceof Error ? error.message : String(error))
  }
}

/**
 * Format logs for display
 */
export function formatLogsForDisplay(logs: ProgressionLogEntry[]): string {
  if (logs.length === 0) {
    return "No logs yet. Enable the connection to start logging."
  }

  return logs
    .map((log) => {
      const time = new Date(log.timestamp).toLocaleTimeString()
      const level = log.level.toUpperCase().padEnd(7)
      const details = log.details && Object.keys(log.details).length > 0 ? ` | ${JSON.stringify(log.details)}` : ""
      return `[${time}] ${level} | ${log.phase.padEnd(20)} | ${log.message}${details}`
    })
    .join("\n")
}
