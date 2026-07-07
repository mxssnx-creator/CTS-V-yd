/**
 * Redis Persistence Layer - File-based backup for continuous session state
 * Saves Redis data to disk every 3 minutes
 * On restart, loads persisted data to restore continuous operation
 * Ensures UI state is consistent across page refreshes and rebuilds
 */

import fs from "fs"
import path from "path"

const DATA_DIR =
  process.env.VERCEL || process.env.AWS_LAMBDA_FUNCTION_NAME
    ? path.join("/tmp", "data")
    : path.join(process.cwd(), "data")

const REDIS_PERSISTENCE_FILE = path.join(DATA_DIR, "redis-persistent.json")
const PERSISTENCE_INTERVAL_MS = 3 * 60 * 1000 // 3 minutes
const BACKUP_INTERVAL_MS = 15 * 60 * 1000 // 15 minutes for rotating backups

let persistenceInterval: NodeJS.Timeout | null = null
let lastBackupTime = 0
let persistenceEnabled = true

interface PersistenceData {
  version: string
  timestamp: number
  dataSnapshot: {
    strings: Record<string, string>
    hashes: Record<string, Record<string, string>>
    sets: Record<string, string[]>
    lists: Record<string, string[]>
    sorted_sets: Record<string, Array<{ score: number; member: string }>>
    ttl: Record<string, number>
  }
}

function ensureDataDir() {
  try {
    if (!fs.existsSync(DATA_DIR)) {
      fs.mkdirSync(DATA_DIR, { recursive: true })
      console.log("[v0] Created data directory for persistence:", DATA_DIR)
    }
  } catch (error) {
    console.error("[v0] Error creating data directory:", error)
    persistenceEnabled = false
  }
}

/**
 * Convert Redis internal data structure to JSON-serializable format
 */
function serializeRedisData(redisData: any): PersistenceData["dataSnapshot"] {
  try {
    return {
      strings: Object.fromEntries(redisData.strings || new Map()),
      hashes: Object.fromEntries(redisData.hashes || new Map()),
      sets: Object.fromEntries(
        Array.from(
          (redisData.sets || new Map<string, Set<string>>()) as Map<string, Set<string>>
        ).map(([k, v]) => [k, Array.from(v)])
      ),
      lists: Object.fromEntries(redisData.lists || new Map()),
      sorted_sets: Object.fromEntries(
        Array.from(
          (redisData.sorted_sets ||
            new Map<string, { entries: Array<{ score: number; member: string }> }>()) as Map<
            string,
            { entries: Array<{ score: number; member: string }> }
          >
        ).map(([k, v]) => [k, v.entries])
      ),
      ttl: Object.fromEntries(redisData.ttl || new Map()),
    }
  } catch (error) {
    console.error("[v0] Error serializing Redis data:", error)
    return {
      strings: {},
      hashes: {},
      sets: {},
      lists: {},
      sorted_sets: {},
      ttl: {},
    }
  }
}

/**
 * Save Redis data to disk
 */
export async function persistRedisDataToDisk(redisData: any): Promise<boolean> {
  if (!persistenceEnabled) return false

  try {
    ensureDataDir()

    const persistenceData: PersistenceData = {
      version: "1.0",
      timestamp: Date.now(),
      dataSnapshot: serializeRedisData(redisData),
    }

    const tempFile = `${REDIS_PERSISTENCE_FILE}.tmp`
    fs.writeFileSync(tempFile, JSON.stringify(persistenceData, null, 2))
    fs.renameSync(tempFile, REDIS_PERSISTENCE_FILE)

    console.log(
      "[v0] Redis data persisted to disk:",
      `(${Object.keys(persistenceData.dataSnapshot.strings).length} keys)`
    )

    // Rotate backups every 15 minutes
    if (Date.now() - lastBackupTime > BACKUP_INTERVAL_MS) {
      const backupFile = `${REDIS_PERSISTENCE_FILE}.${new Date().toISOString().slice(0, 19).replace(/:/g, "-")}`
      fs.copyFileSync(REDIS_PERSISTENCE_FILE, backupFile)
      lastBackupTime = Date.now()
      console.log("[v0] Backup created:", backupFile)
    }

    return true
  } catch (error) {
    console.error("[v0] Error persisting Redis data:", error)
    return false
  }
}

/**
 * Load Redis data from disk
 */
export async function loadRedisDataFromDisk(): Promise<any | null> {
  if (!persistenceEnabled) return null

  try {
    if (!fs.existsSync(REDIS_PERSISTENCE_FILE)) {
      console.log("[v0] No persisted Redis data found, starting fresh")
      return null
    }

    const content = fs.readFileSync(REDIS_PERSISTENCE_FILE, "utf-8")
    const persistenceData: PersistenceData = JSON.parse(content)

    // Validate timestamp (skip if > 24 hours old)
    const ageMs = Date.now() - persistenceData.timestamp
    if (ageMs > 24 * 60 * 60 * 1000) {
      console.log("[v0] Persisted data too old, starting fresh")
      return null
    }

    console.log(
      "[v0] Loaded persisted Redis data:",
      `(age: ${Math.round(ageMs / 1000)}s, ${Object.keys(persistenceData.dataSnapshot.strings).length} keys)`
    )

    // Reconstruct Redis data structure
    const reconstructedData = {
      strings: new Map(Object.entries(persistenceData.dataSnapshot.strings)),
      hashes: new Map(Object.entries(persistenceData.dataSnapshot.hashes)),
      sets: new Map(
        Object.entries(persistenceData.dataSnapshot.sets).map(([k, v]) => [k, new Set(v as string[])])
      ),
      lists: new Map(Object.entries(persistenceData.dataSnapshot.lists)),
      sorted_sets: new Map(
        Object.entries(persistenceData.dataSnapshot.sorted_sets).map(([k, entries]) => [
          k,
          {
            entries: entries as Array<{ score: number; member: string }>,
            memberIndex: new Map((entries as Array<{ score: number; member: string }>).map((e) => [e.member, e])),
          },
        ])
      ),
      ttl: new Map(Object.entries(persistenceData.dataSnapshot.ttl)),
    }

    return reconstructedData
  } catch (error) {
    console.error("[v0] Error loading persisted Redis data:", error)
    return null
  }
}

/**
 * Start automatic persistence loop (call from server initialization)
 */
export function startPersistenceLoop(redisDataGetter: () => any): void {
  if (persistenceInterval) return // Already running

  ensureDataDir()

  console.log("[v0] Starting Redis persistence loop (every 3 minutes)")

  // Persist immediately
  persistRedisDataToDisk(redisDataGetter())

  // Then every 3 minutes
  persistenceInterval = setInterval(() => {
    try {
      const redisData = redisDataGetter()
      if (redisData) {
        persistRedisDataToDisk(redisData)
      }
    } catch (error) {
      console.error("[v0] Error in persistence loop:", error)
    }
  }, PERSISTENCE_INTERVAL_MS)

  // Prevent the interval from keeping the process alive
  persistenceInterval.unref?.()
}

/**
 * Stop persistence loop (cleanup)
 */
export function stopPersistenceLoop(): void {
  if (persistenceInterval) {
    clearInterval(persistenceInterval)
    persistenceInterval = null
    console.log("[v0] Redis persistence loop stopped")
  }
}

/**
 * Force immediate persistence
 */
export async function forcePersistence(redisData: any): Promise<boolean> {
  return persistRedisDataToDisk(redisData)
}

/**
 * Get persistence status
 */
export function getPersistenceStatus() {
  return {
    enabled: persistenceEnabled,
    persistenceFile: REDIS_PERSISTENCE_FILE,
    interval: PERSISTENCE_INTERVAL_MS,
    exists: fs.existsSync(REDIS_PERSISTENCE_FILE),
  }
}
