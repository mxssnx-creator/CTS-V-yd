import { getRedisClient } from "./redis-db"

interface LogEntry {
  timestamp: string
  level: "info" | "warn" | "error"
  category: string
  message: string
  metadata?: Record<string, any>
}

type LoggerGlobals = {
  queue?: LogEntry[]
  flushing?: boolean
}
const loggerGlobals = globalThis as unknown as { __v0_system_logger?: LoggerGlobals }
if (!loggerGlobals.__v0_system_logger) loggerGlobals.__v0_system_logger = {}
const LOGGER = loggerGlobals.__v0_system_logger
const logQueue: LogEntry[] = LOGGER.queue ?? (LOGGER.queue = [])
const MAX_PENDING_LOGS = 1000
const LOG_FLUSH_BATCH_SIZE = 50

function scheduleLogFlush(): void {
  if (LOGGER.flushing) return
  LOGGER.flushing = true
  const run = async () => {
    try {
      await SystemLogger.flushQueuedLogs()
    } finally {
      LOGGER.flushing = false
      if (logQueue.length > 0) scheduleLogFlush()
    }
  }
  if (typeof setImmediate === "function") {
    setImmediate(() => void run())
  } else {
    queueMicrotask(() => void run())
  }
}

export class SystemLogger {
  static async logToDatabase(entry: LogEntry): Promise<void> {
    // Logging must never stall trading/API actions. Enqueue and let a
    // microtask/setImmediate drain a small batch in the background; cap memory
    // by dropping oldest pending entries when Redis is slow/unavailable.
    if (logQueue.length >= MAX_PENDING_LOGS) {
      logQueue.splice(0, logQueue.length - MAX_PENDING_LOGS + 1)
    }
    logQueue.push(entry)
    scheduleLogFlush()
  }

  static async flushQueuedLogs(): Promise<void> {
    const batch = logQueue.splice(0, LOG_FLUSH_BATCH_SIZE)
    if (batch.length === 0) return

    try {
      const client = getRedisClient()
      for (const entry of batch) {
        const logId = `log:${Date.now()}:${Math.random().toString(36).substr(2, 9)}`
        const logKey = logId
        const logEntry = {
          id: logId,
          timestamp: entry.timestamp,
          level: entry.level,
          category: entry.category,
          message: entry.message,
          metadata: entry.metadata ? JSON.stringify(entry.metadata).slice(0, 4000) : "",
        }

        await client.hset(logKey, logEntry)
        await client.lpush("logs:all:list", logId)
        await client.lpush(`logs:${entry.category}:list`, logId)
        await client.expire(logKey, 604800)
      }

      await Promise.all([
        client.ltrim("logs:all:list", 0, 4999),
        client.expire("logs:all:list", 604800),
        ...Array.from(new Set(batch.map((entry) => entry.category))).flatMap((category) => [
          client.ltrim(`logs:${category}:list`, 0, 999),
          client.expire(`logs:${category}:list`, 604800),
        ]),
      ])
    } catch (error) {
      // Drop this batch when logging storage is stuck. Logs are diagnostic only;
      // retry loops here previously caused high memory/CPU and made trading
      // actions appear frozen behind logging.
      console.error("[SystemLogger] Failed to flush queued logs:", error)
    }
  }

  static async logAPI(message: string, level: "info" | "warn" | "error" = "info", endpoint?: string, data?: any): Promise<void> {
    await this.logToDatabase({
      timestamp: new Date().toISOString(),
      level,
      category: "api",
      message,
      metadata: { endpoint, ...data },
    })
  }

  static async logConnection(message: string, connectionId?: string, level: "info" | "warn" | "error" = "info", data?: any): Promise<void> {
    await this.logToDatabase({
      timestamp: new Date().toISOString(),
      level,
      category: "connections",
      message,
      metadata: { connectionId, ...data },
    })
  }

  static async logTradeEngine(
    message: string,
    levelOrData?: "info" | "warn" | "error" | Record<string, any>,
    maybeData?: Record<string, any>,
  ): Promise<void> {
    const level = typeof levelOrData === "string" ? levelOrData : "info"
    const metadata = typeof levelOrData === "string" ? maybeData : levelOrData

    await this.logToDatabase({
      timestamp: new Date().toISOString(),
      level,
      category: "trade_engine",
      message,
      metadata,
    })
  }

  static async logTrade(message: string, tradeData?: any): Promise<void> {
    await this.logToDatabase({
      timestamp: new Date().toISOString(),
      level: "info",
      category: "trades",
      message,
      metadata: tradeData,
    })
  }

  static async logPosition(message: string, positionData?: any): Promise<void> {
    await this.logToDatabase({
      timestamp: new Date().toISOString(),
      level: "info",
      category: "positions",
      message,
      metadata: positionData,
    })
  }

  static async logError(arg1: any, arg2: any, arg3?: any): Promise<void> {
    const category = typeof arg1 === "string" ? arg1 : typeof arg2 === "string" ? arg2 : "system"
    const error = typeof arg1 === "string" ? arg2 : arg1
    const context = typeof arg1 === "string" ? arg3 : arg3 ?? { source: arg2 }

    await this.logToDatabase({
      timestamp: new Date().toISOString(),
      level: "error",
      category,
      message: error instanceof Error ? error.message : String(error),
      metadata: { ...context, stack: error instanceof Error ? error.stack : undefined },
    })
  }

  static async logToast(message: string, level: "info" | "warn" | "error" = "info", data?: any): Promise<void> {
    await this.logToDatabase({
      timestamp: new Date().toISOString(),
      level,
      category: "toast",
      message,
      metadata: data,
    })
  }

  static async logWarning(category: string, message: string, data?: any): Promise<void> {
    await this.logToDatabase({
      timestamp: new Date().toISOString(),
      level: "warn",
      category,
      message,
      metadata: data,
    })
  }

  static async getLogs(
    category?: string,
    limit: number = 100,
  ): Promise<LogEntry[]> {
    try {
      const client = getRedisClient()
      // Read from bounded lists (new format) with fallback to legacy sets
      const listKey = category ? `logs:${category}:list` : "logs:all:list"
      let logIds = await client.lrange(listKey, 0, limit - 1).catch(() => [] as string[])
      
      // Fallback to legacy set if list is empty (migration period)
      if (!logIds || logIds.length === 0) {
        const setKey = category ? `logs:${category}` : "logs:all"
        logIds = (await client.smembers(setKey).catch(() => [] as string[])).slice(-limit)
      }

      const logs: LogEntry[] = []
      for (const logId of logIds) {
        const logData = await client.hgetall(logId)
        if (logData && Object.keys(logData).length > 0) {
          logs.push({
            timestamp: logData.timestamp || "",
            level: (logData.level as any) || "info",
            category: logData.category || "",
            message: logData.message || "",
            metadata: logData.metadata ? JSON.parse(logData.metadata) : undefined,
          })
        }
      }
      return logs
    } catch (error) {
      console.error("[SystemLogger] Failed to retrieve logs:", error)
      return []
    }
  }

  static async clearLogs(category?: string): Promise<void> {
    try {
      const client = getRedisClient()
      // Clear both list (new) and set (legacy) indexes
      const listKey = category ? `logs:${category}:list` : "logs:all:list"
      const setKey = category ? `logs:${category}` : "logs:all"
      
      // Get IDs from both list and set
      const listIds = await client.lrange(listKey, 0, -1).catch(() => [] as string[])
      const setIds = await client.smembers(setKey).catch(() => [] as string[])
      const allIds = [...new Set([...listIds, ...setIds])]

      for (const logId of allIds) {
        await client.del(logId)
      }

      await client.del(listKey)
      await client.del(setKey)
      console.log(`[SystemLogger] Cleared logs for category: ${category || "all"}`)
    } catch (error) {
      console.error("[SystemLogger] Failed to clear logs:", error)
    }
  }
}
