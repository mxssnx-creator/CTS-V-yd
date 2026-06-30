import { RedisClientLike, getClient, getRedisRequestsPerSecond } from './redis-db'

export interface RedisHealthStatus {
  status: 'healthy' | 'degraded' | 'unhealthy'
  message: string
  metrics?: {
    dbSize: number
    operationsPerSecond: number
  }
}

export class RedisProcedures {
  private client: RedisClientLike
  private timer: NodeJS.Timeout | null = null

  constructor() {
    this.client = getClient()
    this.startAutoCleanup()
  }

  private startAutoCleanup(): void {
    this.timer = setInterval(() => {
      this.client.cleanupExpiredKeysPublic().catch(console.error)
    }, 60000)
    this.timer.unref?.()
  }

  async healthCheck(): Promise<RedisHealthStatus> {
    try {
      const pong = await this.client.ping()
      if (pong !== 'PONG') {
        return { status: 'unhealthy', message: 'Ping failed' }
      }

      const dbSize = await this.client.dbSize()
      const ops = getRedisRequestsPerSecond()
      
      let status: 'healthy' | 'degraded' = 'healthy'
      if (dbSize > 100000 || ops > 10000) {
        status = 'degraded'
      }

      return {
        status,
        message: `Redis OK (${dbSize} keys, ${ops} ops/s)`,
        metrics: { dbSize, operationsPerSecond: ops }
      }
    } catch (error) {
      return {
        status: 'unhealthy',
        message: error instanceof Error ? error.message : 'Connection failed'
      }
    }
  }

  async analyze(): Promise<{
    totalKeys: number
    prefixes: Record<string, number>
    largeKeys: number
    expired: number
  }> {
    const keys = await this.client.keys('*')
    const prefixes: Record<string, number> = {}
    let largeKeys = 0
    let expired = 0

    for (const key of keys) {
      const prefix = key.split(':')[0]
      prefixes[prefix] = (prefixes[prefix] || 0) + 1

      const value = await this.client.get(key)
      if (value && value.length > 1024) largeKeys++

      const ttl = await this.client.ttl(key)
      if (ttl === -2) expired++
    }

    return { totalKeys: keys.length, prefixes, largeKeys, expired }
  }

  async getStats(): Promise<{
    totalKeys: number
    operationsPerSecond: number
    uptime: number
  }> {
    return {
      totalKeys: await this.client.dbSize(),
      operationsPerSecond: getRedisRequestsPerSecond(),
      uptime: Math.floor(process.uptime()),
    }
  }

  async getPerformance(): Promise<{
    readSpeed: number
    writeSpeed: number
  }> {
    // Simple benchmark
    const keys = await this.client.keys('*')
    const start = Date.now()
    for (let i = 0; i < Math.min(50, keys.length); i++) {
      await this.client.get(keys[i]).catch(() => null)
    }
    const readTime = Date.now() - start
    const readSpeed = keys.length > 0 ? (Math.min(50, keys.length) / (readTime / 1000)) : 0

    const writeStart = Date.now()
    for (let i = 0; i < 50; i++) {
      await this.client.set(`perf:${i}`, `v${i}`).catch(() => null)
    }
    const writeSpeed = 50 / ((Date.now() - writeStart) / 1000)

    return { readSpeed, writeSpeed }
  }

  /**
   * Execute emergency procedures
   */
  async emergency(): Promise<{ success: boolean; actions: string[] }> {
    const actions: string[] = []
    try {
      const health = await this.healthCheck()
      if (health.status !== 'healthy') {
        actions.push(`Health check: ${health.status}`)
      }
      const compact = await this.compact()
      if (compact.removed > 0) {
        actions.push(`Compacted ${compact.removed} keys`)
      }
      return { success: true, actions }
    } catch (error) {
      return { success: false, actions: [`Error: ${error}`] }
    }
  }

  async backup(): Promise<string> {
    const keys = await this.client.keys('*')
    const data: Record<string, string> = {}
    for (const key of keys) {
      const value = await this.client.get(key)
      if (value !== null) data[key] = value
    }
    return JSON.stringify(data)
  }

  async restore(backupJson: string): Promise<void> {
    const backup = JSON.parse(backupJson) as Record<string, string>
    for (const [key, value] of Object.entries(backup)) {
      await this.client.set(key, value)
    }
  }

  async compact(): Promise<{ removed: number }> {
    const before = await this.client.dbSize()
    await this.client.cleanupExpiredKeysPublic()
    const after = await this.client.dbSize()
    return { removed: before - after }
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
  }
}

let instance: RedisProcedures | null = null
export function getRedisProcedures(): RedisProcedures {
  if (!instance) instance = new RedisProcedures()
  return instance
}

// Convenience exports
export async function redisHealth(): Promise<RedisHealthStatus> {
  return getRedisProcedures().healthCheck()
}

export async function redisAnalyze(): Promise<any> {
  return getRedisProcedures().analyze()
}

export async function redisStats(): Promise<any> {
  return getRedisProcedures().getStats()
}

export async function redisPerformance(): Promise<any> {
  return getRedisProcedures().getPerformance()
}

export async function redisEmergency(): Promise<{
  success: boolean
  actions: string[]
  health: any
  compact: { removed: number }
}> {
  const proc = getRedisProcedures()
  const health = await proc.healthCheck()
  const compact = await proc.compact()
  const { success, actions } = await proc.emergency()
  return { success, actions, health, compact }
}

export async function redisBackup(): Promise<string> {
  return getRedisProcedures().backup()
}

export async function redisRestore(backup: string): Promise<void> {
  return getRedisProcedures().restore(backup)
}

export async function redisCompact(): Promise<{ removed: number }> {
  return getRedisProcedures().compact()
}