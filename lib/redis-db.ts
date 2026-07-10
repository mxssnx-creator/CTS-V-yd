/**
 * Redis Database Layer - High Performance Edition v3.0
 * In-memory Redis client for Next.js runtime
 * Handles all database operations for connections, trades, positions, settings
 * Optimized for 80K+ ops/sec with logging disabled
 * @version 3.0.0 - Cache rebuild forced
 *
 * IMPORTANT: This file must NOT import 'fs' or 'path' as it's used by client components
 */

// Force webpack cache invalidation
const REDIS_DB_VERSION = "3.0.0"
void REDIS_DB_VERSION

interface SortedSetEntry {
  score: number
  member: string
}

interface SortedSetData {
  entries: SortedSetEntry[]
  memberIndex: Map<string, SortedSetEntry>
}

interface RedisData {
  strings: Map<string, string>
  hashes: Map<string, Record<string, string>>
  sets: Map<string, Set<string>>
  lists: Map<string, string[]>
  sorted_sets: Map<string, SortedSetData>
  ttl: Map<string, number> // key -> expiration timestamp in ms
  requestStats: {
    lastSecond: number
    requestCount: number
    operationsPerSecond: number
  }
}

// Global storage for persistence across hot reloads
const globalForRedis = globalThis as unknown as {
  __redis_data?: RedisData
  // In-flight guard for loadFromDisk — ensures concurrent initRedis() calls
  // from different module scopes share a single disk-read rather than racing
  // to overwrite each other's post-migration state.
  __redis_load_promise?: Promise<boolean>
  // In-flight guard for the CORE init (client construction + snapshot load +
  // ping), shared across module scopes. Migrations call ensureCoreRedis()
  // instead of initRedis() so the init→runMigrations→init cycle can't deadlock.
  __redis_core_promise?: Promise<void>
  // In-flight guard for the FULL init (core + migrations). All callers await
  // this single promise, so no request proceeds with un-migrated data — the
  // race that existed when isConnected flipped true before migrations ran.
  __redis_init_promise?: Promise<void>
  // True once the on-disk snapshot has been loaded (or confirmed absent) for
  // this process. Gated on its own flag — not on the presence of __redis_data —
  // because the constructor always creates the data maps, so a sync getter that
  // builds the instance early would otherwise make the loader think the
  // snapshot was already applied and skip it, booting with an empty store.
  __redis_snapshot_loaded?: boolean
  // Global equivalent of the module-scoped `isConnected` flag. Allows fresh
  // Next.js dev route modules (which re-evaluate and get isConnected=false) to
  // see the real connected state without re-running initRedis/migrations.
  __redis_fully_connected?: boolean
  __redis_backend?: RedisBackend
}

export type RedisBackend = "inline-local" | "redis-network"

export interface RedisClientLike {
  ping(): Promise<string>
  info(): Promise<string>
  get(key: string): Promise<string | null>
  mget(...keys: string[]): Promise<Array<string | null>>
  set(key: string, value: string, options?: { EX?: number; NX?: boolean; XX?: boolean }): Promise<string | null>
  setex(key: string, seconds: number, value: string): Promise<void | string>
  incr(key: string): Promise<number>
  incrby(key: string, increment: number): Promise<number>
  del(...keys: string[]): Promise<number>
  flushDb(): Promise<void>
  hset(key: string, dataOrField: Record<string, string> | string, value?: string): Promise<number>
  hmset(...args: string[]): Promise<void>
  hgetall(key: string): Promise<Record<string, string>>
  hlen(key: string): Promise<number>
  hget(key: string, field: string): Promise<string | null>
  hdel(key: string, ...fields: string[]): Promise<number>
  hincrby(key: string, field: string, increment: number): Promise<number>
  hincrbyfloat(key: string, field: string, increment: number): Promise<number>
  sadd(key: string, ...members: string[]): Promise<number>
  scard(key: string): Promise<number>
  smembers(key: string): Promise<string[]>
  sismember(key: string, member: string): Promise<number>
  srem(key: string, ...members: string[]): Promise<number>
  expire(key: string, seconds: number): Promise<number>
  lpush(key: string, ...values: string[]): Promise<number>
  rpush(key: string, ...values: string[]): Promise<number>
  lrange(key: string, start: number, stop: number): Promise<string[]>
  ltrim(key: string, start: number, stop: number): Promise<void>
  llen(key: string): Promise<number>
  lrem(key: string, count: number, value: string): Promise<number>
  lpos(key: string, value: string): Promise<number | null>
  lpop(key: string): Promise<string | null>
  rpop(key: string): Promise<string | null>
  eval?(script: string, options: { keys: string[]; arguments: string[] }): Promise<any>
  dbSize(): Promise<number>
  keys(pattern: string): Promise<string[]>
  zadd(key: string, score: number, member: string): Promise<number>
  zrangebyscore(key: string, min: number | string, max: number | string): Promise<string[]>
  zremrangebyscore(key: string, min: number | string, max: number | string): Promise<number>
  zrange(key: string, start: number, stop: number): Promise<string[]>
  zrevrange(key: string, start: number, stop: number): Promise<string[]>
  zscore(key: string, member: string): Promise<string | null>
  zcard(key: string): Promise<number>
  exists(key: string): Promise<number>
  ttl(key: string): Promise<number>
  multi(): { [k: string]: any; exec: () => Promise<any[]> }
  pipeline(): { [k: string]: any; exec: () => Promise<any[]> }
  saveToDisk(): Promise<boolean>
  loadFromDisk(): Promise<boolean>
  saveToDiskSync(): boolean
  persistNow(): Promise<boolean>
  cleanupExpiredKeysPublic(): Promise<number>
  trackDatabaseOperation(limit: number): Promise<{ current: number; limit: number; exceeded: boolean }>
  getDatabaseOperationCount(): Promise<number>
}


export class InlineLocalRedis implements RedisClientLike {
  private data: RedisData

  constructor() {
    // Use global storage for persistence across hot reloads
    if (!globalForRedis.__redis_data) {
      // Initialize with defaults. Do NOT fire loadFromDisk() here — initRedis()
      // awaits it explicitly after construction when wasEmpty=true. Firing a
      // background load here races with initRedis() and overwrites migration
      // writes (ensureBaseConnections / migration 021) because the unawaited
      // Promise settles AFTER migrations have already set is_enabled_dashboard=1.
      globalForRedis.__redis_data = {
        strings: new Map(),
        hashes: new Map(),
        sets: new Map(),
        lists: new Map(),
        sorted_sets: new Map(),
        ttl: new Map(),
        requestStats: {
          lastSecond: Math.floor(Date.now() / 1000),
          requestCount: 0,
          operationsPerSecond: 0,
        },
      }
    }
    
    // Ensure ttl map exists for older data structures
    if (!globalForRedis.__redis_data.ttl) {
      globalForRedis.__redis_data.ttl = new Map()
    }
    
    this.data = globalForRedis.__redis_data
    
    // Run cleanup every 60 seconds to remove expired keys
    this.startTTLCleanup();
    
    // Schedule periodic disk snapshots every 5 minutes
    this.startPersistence();
  }

  // ──────────────────────────────────────────────────────────────────────
  // Disk persistence (snapshot-based, single instance)
  // ─────────────────────────────────�������────────────────────────────────────
  //
  // The "local Redis" is in-memory only, so without a snapshot every
  // deploy / container restart / serverless cold-start wipes EVERYTHING:
  // connections, settings, progression counters, prehistoric flags.
  //
  // This implementation does the simplest thing that survives a restart on
  // a single warm instance:
  //   • saveToDisk():       JSON-serialise data, write atomically (tmp + rename)
  //   • saveToDiskSync():   same, blocking — used in SIGTERM/SIGINT/beforeExit
  //   • loadFromDisk():     read + restore Maps/Sets; rename corrupt file aside
  //   • startPersistence(): once-per-process 5-min interval + signal handlers
  //
  // Notes:
  //   • Defaults to `<cwd>/.v0-data/redis-snapshot.json`, falls back to
  //     `/tmp/v0-redis-snapshot.json` if the cwd path is not writable
  //     (Vercel serverless restricts writes outside `/tmp`).
  //   • This is NOT cross-instance durable. Vercel `/tmp` is per warm
  //     instance; a fresh cold instance starts empty and rebuilds via
  //     migrations. Swap the body of save/load for Vercel Blob to gain
  //     cross-instance durability without changing this surface.
  //   • Browser builds: every entry point exits early via the `process`
  //     guard so client bundles never pull in `node:fs`. We use dynamic
  //     `await import("node:fs/promises")` to keep the file's "no static
  //     fs/path imports" contract (see header comment).
  //
  // Failure-mode philosophy: the in-memory store keeps working regardless
  // of disk failures — the only observable effect of a broken disk is a
  // single rate-limited warning per minute and no cross-restart recovery.

  private static persistenceTickStarted = false
  private static signalsAttached = false
  private static lastSaveErrorWarn = 0
  // Per-process unique suffix so concurrent Next.js workers never collide on
  // the same `.tmp` file, which caused the ENOENT "rename .tmp -> final" race.
  private static readonly writeSuffix = `${process.pid ?? Math.random().toString(36).slice(2)}`
  // In-process write mutex — prevents concurrent saveToDisk() calls from the
  // same worker from racing each other.
  private static saveInProgress = false

  /** Resolve snapshot path; honours `V0_REDIS_SNAPSHOT_PATH` env override. */
  private async resolveSnapshotPath(): Promise<{ dir: string; file: string } | null> {
    if (typeof process === "undefined" || !process.versions?.node) return null
    try {
      // Bare specifier (no `node:` URI scheme) — Webpack 5's bundler can
      // analyse this and Node's resolver maps it to the built-in. The
      // `node:path` form triggers `UnhandledSchemeError` on the Edge
      // build because Webpack's scheme handler doesn't recognise it.
      // Bare imports are aliased to `false` for the Edge runtime in
      // `next.config.mjs`, which short-circuits the load (the runtime
      // guard above already returns `null` before this line ever runs).
      const path = await import("path")
      const explicit = process.env.V0_REDIS_SNAPSHOT_PATH
      if (explicit) {
        return { dir: path.dirname(explicit), file: explicit }
      }
      // Prefer cwd/.v0-data; fall back to /tmp in restricted environments.
      const primary = path.join(process.cwd(), ".v0-data", "redis-snapshot.json")
      return { dir: path.dirname(primary), file: primary }
    } catch {
      return null
    }
  }

  /** Fallback: write to `/tmp` when the primary path is read-only. */
  private async tmpFallbackPath(): Promise<{ dir: string; file: string } | null> {
    if (typeof process === "undefined" || !process.versions?.node) return null
    try {
      // Bare specifier — see comment in `resolveSnapshotPath`.
      const path = await import("path")
      return { dir: "/tmp", file: path.join("/tmp", "v0-redis-snapshot.json") }
    } catch {
      return null
    }
  }

  /**
   * Build a JSON-safe snapshot of the in-memory data. We can't JSON-stringify
   * Maps and Sets directly, so we materialise them as arrays of entries.
   * Format is versioned (`v: 1`) so future shape changes can migrate cleanly.
   */
  private buildSnapshot(): string {
    const d = this.data
    return JSON.stringify({
      v: 1,
      savedAt: Date.now(),
      strings: Array.from(d.strings.entries()),
      hashes: Array.from(d.hashes.entries()),
      sets: Array.from(d.sets.entries()).map(([k, s]) => [k, Array.from(s)]),
      lists: Array.from(d.lists.entries()),
      sorted_sets: Array.from(d.sorted_sets.entries()).map(([k, z]) => [k, z.entries]),
      ttl: Array.from(d.ttl.entries()),
    })
  }

  /** Restore Maps/Sets from a parsed snapshot. Tolerant of partial files. */
  private applySnapshot(parsed: any): boolean {
    if (!parsed || typeof parsed !== "object") return false
    const d = this.data
    try {
      if (Array.isArray(parsed.strings))
        d.strings = new Map(parsed.strings)
      if (Array.isArray(parsed.hashes))
        d.hashes = new Map(parsed.hashes)
      if (Array.isArray(parsed.sets))
        d.sets = new Map(parsed.sets.map(([k, s]: [string, string[]]) => [k, new Set(s)]))
      if (Array.isArray(parsed.lists))
        d.lists = new Map(parsed.lists)
      if (Array.isArray(parsed.sorted_sets))
        d.sorted_sets = new Map(
          parsed.sorted_sets.map(([k, z]: [string, SortedSetEntry[] | { entries?: SortedSetEntry[] }]) => [
            k,
            this.createSortedSet(Array.isArray(z) ? z : z?.entries || []),
          ]),
        )
      if (Array.isArray(parsed.ttl))
        d.ttl = new Map(parsed.ttl)
      return true
    } catch {
      return false
    }
  }

  /** Single rate-limited warning per minute so a broken disk doesn't spam logs. */
  private warnRateLimited(msg: string, err: unknown): void {
    const now = Date.now()
    if (now - InlineLocalRedis.lastSaveErrorWarn < 60_000) return
    InlineLocalRedis.lastSaveErrorWarn = now
    const detail = err instanceof Error ? err.message : String(err)
    console.warn(`[v0] [Redis Persistence] ${msg}: ${detail}`)
  }

  async loadFromDisk(): Promise<boolean> {
    // ── Safety guard: prevent snapshot reload if engine is running ──
    // In dev mode, multiple Next.js workers each call initRedis()
    // independently. Each worker loads the snapshot, which can overwrite
    // lock values held by a live engine in a different worker. This causes
    // "ownership loss" crashes. Check the global flag published by the
    // trade-engine coordinator; if ANY engine is active, skip the reload.
    const globalCtx = globalThis as any
    const coordinator = globalCtx.__tradeEngineCoordinator
    const coordinatorHasEngines =
      coordinator &&
      typeof coordinator.getActiveEngineCount === "function" &&
      Number(coordinator.getActiveEngineCount()) > 0
    if (globalCtx.__engine_manager_instance?.isEngineRunning || coordinatorHasEngines) {
      console.log(`[v0] [Redis] Snapshot reload skipped: engine/coordinator running in this process`)
      return false
    }

    const target = await this.resolveSnapshotPath()
    if (!target) return false
    // Bare specifier — see comment in `resolveSnapshotPath`. Type alias
    // also drops the `node:` prefix so the bundler doesn't analyse it.
    let fs: typeof import("fs/promises")
    try {
      fs = await import("fs/promises")
    } catch {
      return false
    }
    // Try primary path, then `/tmp` fallback.
    const candidates = [target, await this.tmpFallbackPath()].filter(Boolean) as Array<{ file: string }>
    for (const c of candidates) {
      try {
        const raw = await fs.readFile(c.file, "utf8")
        const parsed = JSON.parse(raw)
        if (this.applySnapshot(parsed)) {
          const keys =
            this.data.strings.size + this.data.hashes.size + this.data.sets.size +
            this.data.lists.size + this.data.sorted_sets.size
          console.log(`[v0] [Redis Persistence] Restored ${keys} keys from ${c.file}`)
          return true
        }
        // Parsed but didn't fit — quarantine and continue.
        try { await fs.rename(c.file, `${c.file}.corrupt-${Date.now()}`) } catch {}
      } catch (err: any) {
        if (err?.code === "ENOENT") continue // no snapshot yet
        if (err instanceof SyntaxError) {
          // Corrupt JSON — move it aside so we don't keep failing.
          try { await fs.rename(c.file, `${c.file}.corrupt-${Date.now()}`) } catch {}
          continue
        }
        // Other I/O error — try fallback.
        continue
      }
    }
    return false
  }

  async saveToDisk(): Promise<boolean> {
    // In-process mutex: if a save is already in flight from this worker,
    // skip rather than race on the .tmp file.
    if (InlineLocalRedis.saveInProgress) return false
    InlineLocalRedis.saveInProgress = true
    try {
      const primary = await this.resolveSnapshotPath()
      if (!primary) return false
      // Bare specifier — see comment in `resolveSnapshotPath`.
      let fs: typeof import("fs/promises")
      try {
        fs = await import("fs/promises")
      } catch {
        return false
      }
      const json = this.buildSnapshot()
      // Try primary then `/tmp` fallback so a read-only cwd doesn't lose data.
      const candidates = [primary, await this.tmpFallbackPath()].filter(Boolean) as Array<{ dir: string; file: string }>
      for (const c of candidates) {
        try {
          await fs.mkdir(c.dir, { recursive: true })
          // Use a per-PID suffix so concurrent Next.js workers never collide
          // on the same .tmp file (previously caused ENOENT on rename).
          const tmpPath = `${c.file}.${InlineLocalRedis.writeSuffix}.tmp`
          await fs.writeFile(tmpPath, json, "utf8")
          // Atomic on POSIX — readers either see old or new, never partial.
          await fs.rename(tmpPath, c.file)
          return true
        } catch (err) {
          // Try next fallback. Only warn after we've exhausted everything.
          if (c === candidates[candidates.length - 1]) {
            this.warnRateLimited(`save failed (${c.file})`, err)
          }
          continue
        }
      }
      return false
    } finally {
      InlineLocalRedis.saveInProgress = false
    }
  }

  /** Synchronous variant for SIGTERM / SIGINT / beforeExit handlers. */
  saveToDiskSync(): boolean {
    if (typeof process === "undefined" || !process.versions?.node) return false
    // Type aliases use bare specifiers so TypeScript's emitted .d.ts
    // (and any incremental compile cache) don't carry `node:` URIs that
    // could re-enter the bundler graph.
    let fsSync: typeof import("fs"), pathMod: typeof import("path")
    try {
      // require() is fine here because this method only ever runs in Node.
      // We use dynamic require via Function to bypass static-bundler analysis.
      const dynamicRequire = Function("m", "return require(m)") as (m: string) => any
      // Bare specifiers — Node maps these to the built-ins identically
      // to the `node:` URI form. Avoiding the URI form here keeps the
      // request strings out of any chunk the bundler might still scan
      // (defence in depth — `Function(...)` already hides them).
      fsSync = dynamicRequire("fs")
      pathMod = dynamicRequire("path")
    } catch {
      return false
    }
    const explicit = process.env.V0_REDIS_SNAPSHOT_PATH
    const primaryFile = explicit || pathMod.join(process.cwd(), ".v0-data", "redis-snapshot.json")
    const tmpFile = pathMod.join("/tmp", "v0-redis-snapshot.json")
    const json = this.buildSnapshot()
    const suffix = InlineLocalRedis.writeSuffix
    for (const file of [primaryFile, tmpFile]) {
      try {
        const dir = pathMod.dirname(file)
        fsSync.mkdirSync(dir, { recursive: true })
        // PID-unique tmp file prevents cross-worker rename races (ENOENT).
        const tmp = `${file}.${suffix}.tmp`
        fsSync.writeFileSync(tmp, json, "utf8")
        fsSync.renameSync(tmp, file)
        return true
      } catch {
        continue
      }
    }
    return false
  }

  async startPersistence(): Promise<boolean> {
    if (typeof process === "undefined" || !process.versions?.node) return false
    if (InlineLocalRedis.persistenceTickStarted) return true
    InlineLocalRedis.persistenceTickStarted = true

    // ── Continuous session persistence ──
    // 3-minute snapshot interval ensures continuous operation across rebuilds,
    // page refreshes, and restarts. Data is restored on startup, maintaining
    // engine progress, UI state, and trading history without interruption.
    // unref() so this timer never holds the process open during a graceful exit.
    const THREE_MIN_MS = 3 * 60 * 1000 // 3 minutes for continuous session state
    const t = setInterval(() => {
      this.saveToDisk().catch(() => { /* warned inside saveToDisk */ })
    }, THREE_MIN_MS)
    if (typeof t.unref === "function") t.unref()

    // Flush-on-exit handlers (idempotent).
    if (!InlineLocalRedis.signalsAttached) {
      InlineLocalRedis.signalsAttached = true
      const flush = () => { try { this.saveToDiskSync() } catch {} }
      // setMaxListeners is a NodeEventEmitter API; guard for ts safety.
      try { (process as any).setMaxListeners?.(50) } catch {}
      process.on("SIGTERM", flush)
      process.on("SIGINT", flush)
      process.on("beforeExit", flush)
    }
    return true
  }
  

  async cleanupVolatileRuntimeState({
    reason = "startup",
  }: { mode?: string; reason?: string } = {}): Promise<{ deleted: number; preserved: number }> {
    const staleMs = Number(process.env.VOLATILE_STATE_STALE_MS || process.env.REDIS_VOLATILE_STALE_MS || 6 * 60 * 60 * 1000)
    const now = Date.now()
    let deleted = 0
    let preserved = 0

    const deleteKey = (key: string) => {
      const before = this.data.strings.has(key) || this.data.hashes.has(key) || this.data.sets.has(key) || this.data.lists.has(key) || this.data.sorted_sets.has(key)
      this.deleteKey(key)
      if (before) deleted++
    }
    const olderThanThreshold = (key: string, raw?: string | null): boolean => {
      const ttl = this.data.ttl?.get(key)
      if (ttl && ttl <= now) return true
      const timestamp = Number(raw || "")
      if (Number.isFinite(timestamp) && timestamp > 0 && now - timestamp > staleMs) return true
      return !ttl && !timestamp
    }
    const shouldDelete = (key: string, raw?: string | null): boolean => {
      // Volatile-state cleanup policy — same in all modes:
      // live:position:tracking:* and :moved: are transient indexes; always safe to drop.
      if (key.startsWith("live:position:") || key.startsWith("live:positions:") || key.startsWith("settings:live:")) {
        return key.startsWith("live:position:tracking:") || key.includes(":moved:")
      }
      // live:lock:* is a transient gate: delete only expired/old/missing-TTL locks.
      if (key.startsWith("live:lock:")) return olderThanThreshold(key, raw)
      // Prehistoric gates/progress are boot cache gates, not authoritative data.
      if (key.startsWith("prehistoric_loaded:") || key.startsWith("prehistoric:progress:")) return olderThanThreshold(key, raw)
      // Pipeline families are rebuilt each cycle — safe to evict on startup.
      if (key.startsWith("pseudo_position:") || key.startsWith("pseudo_positions:")) return true
      if (key.startsWith("settings:pseudo_position") || key.startsWith("settings:pseudo_positions:")) return true
      if (key.startsWith("indication_set:") || key.startsWith("indication_outcomes_pending:")) return true
      if (key.startsWith("strategies:") || key.startsWith("settings:strategies")) return true
      return false
    }

    for (const [key, value] of Array.from(this.data.strings.entries())) shouldDelete(key, value) ? deleteKey(key) : preserved++
    for (const key of Array.from(this.data.hashes.keys())) shouldDelete(key) ? deleteKey(key) : preserved++
    for (const key of Array.from(this.data.sets.keys())) shouldDelete(key) ? deleteKey(key) : preserved++
    for (const key of Array.from(this.data.lists.keys())) shouldDelete(key) ? deleteKey(key) : preserved++
    for (const key of Array.from(this.data.sorted_sets.keys())) shouldDelete(key) ? deleteKey(key) : preserved++

    if (deleted > 0) {
      console.log(`[v0] [Redis Memory] Volatile startup cleanup (${reason}): deleted ${deleted} keys, preserved ${preserved}`)
    }
    return { deleted, preserved }
  }

  private startTTLCleanup(): void {
    // TTL-based cleanup + LRU eviction when heap memory exceeds threshold.
    // In dev mode the InlineLocalRedis emulator holds the ENTIRE dataset on
    // the Node heap (in prod this lives in real Redis, off-heap). During live
    // trading the per-cycle pipeline writes thousands of `pseudo_position:*`
    // and `config_set:*` hashes plus a growing `pseudo_positions:{conn}` set
    // every second; left unchecked this drove heapUsed past the 4GB V8 ceiling
    // and OOM-killed next-server seconds after live trading began.
    const globalCleanup = globalThis as unknown as {
      __redis_cleanup_started?: boolean
      __redis_mem_limits?: { heapMB: number; rssSoftMB: number; rssHardMB: number; maxKeys: number }
    }

    // ── Dynamic memory limits ────────────────────────────────────────────────
    // Computed BEFORE the startup guard so the thresholds update on every
    // HMR reload (the guard below only prevents the timer from being
    // registered twice, not the threshold computation from re-running).
    // Reads /proc/meminfo each time so values are always proportional to
    // the actual VM; fallback 4096 MB for unknown environments.
    {
      const _readVmTotalMB = (): number => {
        try {
          const fs = require("fs") as typeof import("fs")
          const raw = fs.readFileSync("/proc/meminfo", "utf8")
          const match = raw.match(/MemTotal:\s+(\d+)\s+kB/)
          return match ? Math.round(parseInt(match[1], 10) / 1024) : 4_096
        } catch {
          return 4_096
        }
      }
      const vmTotalMB   = _readVmTotalMB()
      // Reserve 1.5 GB for OS + other processes. On the 8.4 GB VM usable = 6.9 GB.
      // Kernel OOM on Linux typically fires at ~95% physical RAM consumption;
      // we keep a ~18% buffer (rssHard at 82%) so the EMERGENCY pause (×1.07)
      // fires at ~88%, well below kernel OOM. With SYMBOL_CONCURRENCY=1 and
      // exchange-close retries eliminated, working RSS is ~3-4 GB; the old
      // 75% rssHard (4769 MB) was tripping CRITICAL evictions on normal traffic.
      const usableMB    = Math.max(1_500, vmTotalMB - 1_500)
      // Heap trigger: 60% of usable (was 55%)
      const heapMB      = Math.round(usableMB * 0.60)
      // RSS soft: 72% of usable — force GC above this (was 65%).
      const rssSoftMB   = Math.round(usableMB * 0.72)
      // RSS hard: 82% of usable — critical eviction + sleep above this (was 75%).
      const rssHardMB   = Math.round(usableMB * 0.82)
      const _nSyms      = Math.max(1, parseInt(process.env.V0_DEV_SYMBOL_COUNT ?? "4", 10) || 4)
      const maxKeys     = Math.round(1_000 + _nSyms * 800 * Math.max(1, usableMB / 2_048))
      const prev = globalCleanup.__redis_mem_limits
      const changed = !prev || prev.rssHardMB !== rssHardMB
      globalCleanup.__redis_mem_limits = { heapMB, rssSoftMB, rssHardMB, maxKeys }
      if (changed) {
        console.log(
          `[v0] [Redis Memory] VM=${vmTotalMB}MB usable=${usableMB}MB ` +
          `→ heapTrigger=${heapMB}MB rssSoft=${rssSoftMB}MB rssHard=${rssHardMB}MB maxKeys=${maxKeys}`
        )
      }
    }

    if (globalCleanup.__redis_cleanup_started) return
    globalCleanup.__redis_cleanup_started = true

    const MEM = globalCleanup.__redis_mem_limits

    // Run an immediate targeted flush at startup to clear volatile key families
    // that accumulate across hot-reload cycles.
    void this.cleanupVolatileRuntimeState({ reason: "inline-startup" })

    // Keep the once-per-second timer cheap: memoryUsage() and Map.size reads are
    // O(1), while TTL expiry and eviction each scan key maps. Run those full
    // scans at a slower cadence during normal operation, but bypass the cadence
    // immediately when memory crosses the configured heap/RSS thresholds.
    const FULL_CLEANUP_INTERVAL_MS = 15_000
    let _lastFullCleanupMs = 0

    // Throttle eviction log output: only print once per 60 s when stuck above
    // the threshold so the server log stays readable.
    let _lastEvictionLogMs = 0

    const ttlCleanupTimer = setInterval(() => {
      try {
        const now        = Date.now()
        const mem        = process.memoryUsage?.() || { heapUsed: 0, rss: 0 }
        const heapUsedMB = mem.heapUsed / 1024 / 1024
        const rssMB      = mem.rss      / 1024 / 1024
        const totalKeys  = this.data.strings.size + this.data.hashes.size +
                           this.data.sets.size + this.data.lists.size + this.data.sorted_sets.size

        // Always read the current thresholds from globalThis so HMR reloads
        // that update percentages are reflected immediately in the timer callback
        // without needing a process restart. Fallback to the module-level MEM
        // snapshot if the global was somehow cleared.
        const CMEM = (globalThis as any).__redis_mem_limits as typeof MEM | undefined ?? MEM

        // Three-tier pressure response:
        //   NORMAL  → TTL cleanup only on the slower full-scan cadence
        //   WARM    → immediately evict + GC when heap/RSS/key pressure is high
        //   CRITICAL → immediately volatile cleanup + 3× evict passes + GC
        const isCritical = rssMB > CMEM.rssHardMB
        const isWarm     = isCritical || heapUsedMB > CMEM.heapMB || rssMB > CMEM.rssSoftMB || totalKeys > CMEM.maxKeys
        const shouldRunFullCleanup = isWarm || now - _lastFullCleanupMs >= FULL_CLEANUP_INTERVAL_MS

        if (!shouldRunFullCleanup) return
        _lastFullCleanupMs = now

        // Expired-key cleanup scans the TTL map, so avoid doing it every second
        // unless pressure requires immediate cleanup.
        this.cleanupExpiredKeys()

        if (!isWarm) return

        if (now - _lastEvictionLogMs > 60_000) {
          _lastEvictionLogMs = now
          const reason = isCritical
            ? `CRITICAL RSS=${rssMB.toFixed(0)}MB >hard ${CMEM.rssHardMB}MB`
            : rssMB > CMEM.rssSoftMB
              ? `RSS=${rssMB.toFixed(0)}MB >soft ${CMEM.rssSoftMB}MB`
              : heapUsedMB > CMEM.heapMB
                ? `Heap=${heapUsedMB.toFixed(0)}MB >${CMEM.heapMB}MB`
                : `Keys=${totalKeys} >${CMEM.maxKeys}`
          // describeKeyFamilies() performs full key-family scans; only pay that
          // cost when a log line will actually be emitted.
          const families = this.describeKeyFamilies()
          console.log(`[v0] [Redis Memory] ${reason} — evicting. Families: ${families}`)
        }

        if (isCritical) {
          // CRITICAL: purge volatile families first, then run 3 eviction passes
          // to maximally reclaim before the engine's next cycle can add more.
          void this.cleanupVolatileRuntimeState({ reason: "critical-rss" })
          this.evictOldRecords()
          this.evictOldRecords()
          this.evictOldRecords()
          ;(globalThis as any).gc?.()
        } else {
          this.evictOldRecords()
          ;(globalThis as any).gc?.()
        }
      } catch {
        // Swallow errors so the cleanup timer never dies
      }
    }, 1_000)
    ttlCleanupTimer.unref?.()
  }
  
  /**
   * Diagnostic: histogram of key counts (and rough sizes for big sets/strings)
   * grouped by the first two `:`-separated segments. Lets the memory-pressure
   * log show exactly WHICH key families grow instead of guessing.
   */
  private describeKeyFamilies(): string {
    const counts = new Map<string, { n: number; approxBytes: number }>()
    const famOf = (k: string) => k.split(":").slice(0, 2).join(":")
    const bump = (k: string, bytes: number) => {
      const fam = famOf(k)
      const cur = counts.get(fam) || { n: 0, approxBytes: 0 }
      cur.n++
      cur.approxBytes += bytes
      counts.set(fam, cur)
    }
    try {
      for (const [k, v] of this.data.strings.entries()) bump(k, typeof v === "string" ? v.length : 64)
      for (const [k, h] of this.data.hashes.entries()) {
        let bytes = 0
        for (const f in h) bytes += f.length + (h[f]?.length ?? 0) + 32
        bump(k, bytes)
      }
      for (const [k, s] of this.data.sets.entries()) bump(k, s.size * 48)
      for (const [k, l] of this.data.lists.entries()) {
        let bytes = 0
        for (const item of l) bytes += (item?.length ?? 0) + 16
        bump(k, bytes)
      }
      for (const [k, z] of this.data.sorted_sets.entries()) bump(k, z.entries.length * 64)
      const top = [...counts.entries()]
        .sort((a, b) => b[1].approxBytes - a[1].approxBytes)
        .slice(0, 8)
        .map(([fam, c]) => `${fam}=${c.n}keys/${(c.approxBytes / 1048576).toFixed(1)}MB`)
      return top.join(" | ")
    } catch {
      return "unavailable"
    }
  }

  private cleanupExpiredKeys(): number {
    const now = Date.now()
    const ttlMap = this.data.ttl
    if (!ttlMap) return 0
    
    let cleaned = 0
    for (const [key, expireAt] of ttlMap.entries()) {
      if (now >= expireAt) {
        this.deleteKey(key)
        ttlMap.delete(key)
        cleaned++
      }
    }
    return cleaned
  }
  
  private evictOldRecords(): number {
    // LRU/FIFO eviction of the key families that accumulate unboundedly on the
    // Node heap in the dev emulator. In production these live in real Redis
    // (off-heap) so this is a dev-only safety net, but it is essential: during
    // live trading the pipeline creates thousands of these per minute.
    let evicted = 0

    // Keys that must NEVER be evicted by memory pressure — they are either
    // stateful operator decisions or live-position tracking records.
    //
    // IMPORTANT: "settings:*" was previously fully protected, but
    // "settings:pseudo_position*" and "settings:strategies*" are high-volume
    // transient pipeline data (not operator config) and must be evictable.
    // The protected guard is narrowed to the genuine operator sub-families only.
    const isProtected = (k: string): boolean => {
      if (k.startsWith("live:position:"))    return true  // open/closed live positions
      if (k.startsWith("live:positions:"))   return true  // open/closed index LISTs
      if (k.startsWith("progression:"))      return true  // progression counters
      if (/^prehistoric:[^:]+$/.test(k))     return true  // prehistoric summary hash for stats
      if (/^prehistoric:[^:]+:symbols$/.test(k)) return true  // processed-symbol denominator set
      if (/^prehistoric:[^:]+:done$/.test(k)) return true  // realtime gate marker
      if (/^prehistoric:[^:]+:firstpass:done$/.test(k)) return true  // first-pass gate
      if (k.startsWith("connection:"))       return true  // exchange credentials
      if (k.startsWith("strategy_count:"))   return true  // strategy count totals
      if (k.startsWith("real_pi_acc:"))      return true  // real PI accumulation
      if (k.startsWith("axis_pos_acc:"))     return true  // axis position accumulation
      if (k.startsWith("app_settings"))      return true  // global app settings
      if (k.startsWith("trade_engine:"))     return true  // engine state
      if (k.startsWith("_migration"))        return true  // migration markers
      if (k.startsWith("_schema_version"))   return true  // schema version
      if (k.startsWith("market_data:"))      return true  // candle blobs (separate cap)
      // strategies:{conn}:live:count — single small key used for dashboard display;
      // written once per cycle (not per symbol) and must survive the strategies:* cap.
      if (/^strategies:[^:]+:live:count$/.test(k)) return true
      // strategies:{conn}:*:total — per-stage set counts for the dashboard.
      if (/^strategies:[^:]+:[^:]+:total$/.test(k)) return true
      // Protect genuine operator settings but NOT transient pipeline families.
      // settings:pseudo_position* and settings:strategies* are written every
      // realtime cycle and must be subject to FIFO caps.
      if (k.startsWith("settings:")) {
        // Transient pipeline families — NOT protected
        if (k.startsWith("settings:pseudo_position")) return false
        if (k.startsWith("settings:strategies"))       return false
        return true  // all other settings: keys are protected operator config
      }
      return false
    }

    // ── Single-pass categorisation ────────────────────────────────────────────
    // The previous multi-pass approach iterated all keys once per family rule
    // (13 hash rules + 9 string rules + 1 candle rule + 1 list rule = 24 passes).
    // At 8000 keys that was 192,000 startsWith() comparisons per eviction run,
    // every 2 seconds. The new approach iterates each store ONCE and categorises
    // into named buckets in-place using early-exit prefix switching — O(N) total
    // with ~8× fewer comparisons per key (average 3 prefix checks vs 24).
    //
    // Bucket names mirror the old family rules, so the cap values are unchanged.
    // ── Dynamic per-symbol eviction caps ──────────────────────────────────
    // Scale linearly with symbol count only — do NOT scale with RAM because
    // larger machines don't need more indication/strategy keys, they just have
    // more headroom before OOM. Scaling caps with RAM was the root cause of
    // the 5+ GB RSS on the 8 GB VM (indication_set floor was 5000 × large hashes).
    const _N = Math.max(1, parseInt(process.env.V0_DEV_SYMBOL_COUNT ?? "4", 10) || 4)

    const CAPS: Record<string, number> = {
      // Pseudo-positions: hard cap independent of RAM — 200 per symbol is plenty
      pseudo_position:              _N * 200,
      s_pseudo_position:            _N * 100,
      // Strategy sets: tight cap; these are rebuilt every cycle
      strategies:                   Math.max(50, _N * 20),
      s_strategies:                 Math.max(10, _N * 8),
      config_set:                   Math.max(400, _N * 25),
      strategy_positions:           Math.max(200, _N * 15),
      strategy_detail:              Math.max(200, _N * 15),
      real_stage:                   Math.max(200, _N * 15),
      // Indication families — drastically reduced to prevent OOM
      indication:                   Math.max(100, _N * 25),
      indications:                  Math.max(50,  _N * 10),
      // indication_set: was 5000 floor, now tight — only need N_symbols × N_types × 2dirs
      // With 4 symbols × 6 types × 2 dirs = 48 max, keep 200 for headroom
      indication_set:               Math.max(200, _N * 50),
      indication_outcomes_pending:  Math.max(50,  _N * 5),
      axis_pos_acc:                 5,
      prehistoric:                  20,
      live_history:                 Math.max(200, _N * 15),
      // string-only
      indications_str:              Math.max(30,  _N * 8),
      dedup:                        Math.max(500, _N * 30),
      candle_cache:                 Math.max(10,  _N * 3),
      candles:                      Math.max(10,  _N * 3),
    }

    // Classify a key into a bucket name; returns null for protected/untracked keys.
    // The switch-ladder uses fast prefix tests ordered by probability of hit —
    // high-frequency pipeline keys first, protected-class checks last.
    const classify = (k: string): string | null => {
      if (isProtected(k)) return null
      // Transient pipeline families (highest write frequency)
      if (k.startsWith("pseudo_position:"))     return "pseudo_position"
      if (k.startsWith("settings:pseudo_position")) return "s_pseudo_position"
      if (k.startsWith("settings:strategies"))  return "s_strategies"
      if (k.startsWith("strategies:")) {
        if (k.startsWith("strategies:all") ||
            k.startsWith("strategies:counter") ||
            k.startsWith("strategies:metadata")) return null
        return "strategies"
      }
      if (k.startsWith("indication_set:"))                 return "indication_set"
      if (k.startsWith("indication_outcomes_pending:"))   return "indication_outcomes_pending"
      if (k.startsWith("axis_pos_acc:"))                  return "axis_pos_acc"
      if (k.startsWith("indication:"))                    return "indication"
      if (k.startsWith("indications:"))                   return "indications"
      if (k.startsWith("config_set:") ||
          k.includes(":config_set:"))            return "config_set"
      if (k.startsWith("strategy:")) {
        if (k.includes(":positions"))            return "strategy_positions"
        if (k.includes(":detail"))               return "strategy_detail"
        return null
      }
      if (k.startsWith("real_stage:") ||
          k.startsWith("realstage:"))            return "real_stage"
      if (k.startsWith("prehistoric:"))          return "prehistoric"
      if (k.startsWith("live_positions:") &&
          k.includes(":history"))                return "live_history"
      if (k.startsWith("strategy_detail:"))      return "strategy_detail"
      if (k.startsWith("candle_cache:") ||
          k.startsWith("market_data_cache:"))    return "candle_cache"
      if (k.startsWith("market_data:") &&
          k.endsWith(":candles"))                return "candles"
      if (k.includes(":exists:") ||
          k.includes(":dedup:"))                 return "dedup"
      return null
    }

    // Helper: trim a bucket array to its cap and evict.
    const trimBucket = (bucket: string[], cap: number): number => {
      if (bucket.length <= cap) return 0
      const drop = bucket.length - cap
      for (let i = 0; i < drop; i++) this.deleteKey(bucket[i])
      return drop
    }

    // ── HASH single-pass ─────────────────��────────────────────────────────
    const hashBuckets = new Map<string, string[]>()
    for (const [key] of this.data.hashes.entries()) {
      const bucket = classify(key)
      if (bucket === null) continue
      let arr = hashBuckets.get(bucket)
      if (!arr) { arr = []; hashBuckets.set(bucket, arr) }
      arr.push(key)
    }
    for (const [bucket, keys] of hashBuckets) {
      const cap = CAPS[bucket] ?? 0
      evicted += trimBucket(keys, cap)
    }

    // ── STRING single-pass ────────────────────────────────────────────────
    // indications:* string blobs get a lower string cap (vs hash cap) since
    // the blob format is larger than the hash representation.
    const strBuckets = new Map<string, string[]>()
    for (const [key] of this.data.strings.entries()) {
      const bucket = classify(key)
      if (bucket === null) continue
      // String-specific override for indications: lower cap.
      const strBucket = bucket === "indications" ? "indications_str" : bucket
      let arr = strBuckets.get(strBucket)
      if (!arr) { arr = []; strBuckets.set(strBucket, arr) }
      arr.push(key)
    }
    for (const [bucket, keys] of strBuckets) {
      const cap = CAPS[bucket] ?? 0
      evicted += trimBucket(keys, cap)
    }

    // ── LIST single-pass ────────────��────────���──────────────────────────��─�����
    // strategies:* lists from strategy-evaluator — capped at 0 in dev.
    {
      const listCap = 50
      const listKeys: string[] = []
      for (const [key] of this.data.lists.entries()) {
        if (!isProtected(key) && key.startsWith("strategies:")) listKeys.push(key)
      }
      evicted += trimBucket(listKeys, listCap)
    }

    // ── Terminal live:position purge ─────────────────────────────────────
    // live:position:* hashes are globally protected (they must survive eviction
    // so open positions are never accidentally dropped). But this means terminal
    // (closed, rejected, cancelled) positions accumulate unboundedly. We trim
    // them here: keep the most-recent MAX_TERMINAL_POSITIONS per connection by
    // inspecting the "status" field of each hash. Open/placed positions are
    // NEVER touched.
    {
      const MAX_TERMINAL_POSITIONS = 200
      const TERMINAL_STATUSES = new Set(["closed","rejected","cancelled","expired","error"])
      // Group terminal position keys by connection id (first segment of the id field
      // or the key itself). Key format: live:position:<id> where id is like
      // "live:bingx-x01:BTCUSDT:long:123456".
      const terminalByConn = new Map<string, Array<[string, number]>>()
      for (const [key, fields] of this.data.hashes.entries()) {
        if (!key.startsWith("live:position:")) continue
        if (key.startsWith("live:position:tracking:")) continue
        // `fields` is a plain Record<string, string> — direct property access.
        const status = fields["status"] ?? ""
        if (!TERMINAL_STATUSES.has(status)) continue
        // Extract connection id from the position id embedded in the hash
        const posId: string = fields["id"] ?? key
        const connMatch = posId.match(/^live:([^:]+:[^:]+):/)
        const connKey = connMatch ? connMatch[1] : "unknown"
        const ts = Number(fields["closedAt"] ?? fields["updatedAt"] ?? 0)
        let arr = terminalByConn.get(connKey)
        if (!arr) { arr = []; terminalByConn.set(connKey, arr) }
        arr.push([key, ts])
      }
      for (const [, positions] of terminalByConn) {
        if (positions.length <= MAX_TERMINAL_POSITIONS) continue
        // Sort oldest-first, drop the excess old ones
        positions.sort((a, b) => a[1] - b[1])
        const drop = positions.length - MAX_TERMINAL_POSITIONS
        for (let i = 0; i < drop; i++) {
          this.data.hashes.delete(positions[i][0])
          evicted++
        }
      }
    }

    // ── Membership sets — prune oversized pseudo-position id sets ─────────
    const SET_MEMBER_CAP = 800   // was 4000 — 800 is plenty for 4 symbols
    for (const [key, members] of this.data.sets.entries()) {
      if (
        (key.startsWith("pseudo_positions:") || key.startsWith("real_pseudo_positions:")) &&
        members.size > SET_MEMBER_CAP
      ) {
        const arr = Array.from(members)
        const keep = new Set(arr.slice(arr.length - SET_MEMBER_CAP))
        this.data.sets.set(key, keep)
        evicted += arr.length - keep.size
      }
    }

    // ── TTL expiry sweep ─────────────────────────────────────────────────────
    // Eagerly delete any keys whose TTL has already passed. Without this, expired
    // keys stay in the Map until a reader calls isExpired(), so the eviction
    // loop above sees them as live entries and keeps them under caps.
    if (this.data.ttl) {
      const now = Date.now()
      for (const [key, expireAt] of this.data.ttl.entries()) {
        if (expireAt <= now) {
          this.deleteKey(key)
          evicted++
        }
      }
    }

    if (evicted > 10) {
      console.log(`[v0] [Redis Memory] Evicted ${evicted} old records to reduce memory pressure`)
      // Nudge V8 GC if --expose-gc was passed (dev start script uses it).
      // After trimming Map entries the GC needs a hint to return the freed
      // memory to the OS heap rather than keeping it as V8 slack capacity.
      ;(globalThis as any).gc?.()
    }
    return evicted
  }
  
  private isExpired(key: string): boolean {
    const ttlMap = this.data.ttl
    if (!ttlMap) return false
    
    const expireAt = ttlMap.get(key)
    if (expireAt && Date.now() >= expireAt) {
      // Only delete expired keys during explicit cleanup operations
      // Not on every read operation!
      // this.deleteKey(key)
      // ttlMap.delete(key)
      return true
    }
    return false
  }
  
  private deleteKey(key: string): void {
    this.cleanupSecondaryIndexesForDeletedKey(key)
    this.data.strings.delete(key)
    this.data.hashes.delete(key)
    this.data.sets.delete(key)
    this.data.lists.delete(key)
    this.data.sorted_sets.delete(key)
    this.data.ttl?.delete(key)
  }

  private cleanupSecondaryIndexesForDeletedKey(key: string): void {
    const removeFromConnectionIndexes = (prefix: string, id: string) => {
      for (const [setKey, members] of this.data.sets.entries()) {
        if (setKey.startsWith(prefix)) {
          members.delete(id)
          if (members.size === 0) this.data.sets.delete(setKey)
        }
      }
    }

    if (key.startsWith("position:")) {
      const id = key.slice("position:".length)
      this.data.sets.get("idx:positions")?.delete(id)
      removeFromConnectionIndexes("idx:positions:connection:", id)
    } else if (key.startsWith("trade:")) {
      const id = key.slice("trade:".length)
      this.data.sets.get("idx:trades")?.delete(id)
      removeFromConnectionIndexes("idx:trades:connection:", id)
    } else if (key.startsWith("indication:")) {
      const id = key.slice("indication:".length)
      this.data.sets.get("idx:indications")?.delete(id)
    } else if (key.startsWith("strategy:")) {
      const id = key.slice("strategy:".length)
      this.data.sets.get("idx:strategies")?.delete(id)
    }
  }

  private compareSortedSetEntries(a: SortedSetEntry, b: SortedSetEntry): number {
    return a.score - b.score || a.member.localeCompare(b.member)
  }

  private createSortedSet(entries: SortedSetEntry[] = []): SortedSetData {
    const memberIndex = new Map<string, SortedSetEntry>()
    const sortedEntries: SortedSetEntry[] = []

    for (const entry of entries) {
      if (!entry || typeof entry.member !== "string") continue
      const normalized = { score: Number(entry.score), member: entry.member }
      if (!Number.isFinite(normalized.score)) continue
      memberIndex.set(normalized.member, normalized)
    }

    sortedEntries.push(...memberIndex.values())
    sortedEntries.sort((a, b) => this.compareSortedSetEntries(a, b))
    return { entries: sortedEntries, memberIndex }
  }

  private getSortedSet(key: string): SortedSetData | undefined {
    const zset = this.data.sorted_sets.get(key)
    if (!zset) return undefined

    // Tolerate in-memory data created by older module versions during hot reload.
    if (Array.isArray(zset)) {
      const migrated = this.createSortedSet(zset)
      this.data.sorted_sets.set(key, migrated)
      return migrated
    }

    if (!zset.memberIndex) {
      const rebuilt = this.createSortedSet(zset.entries || [])
      this.data.sorted_sets.set(key, rebuilt)
      return rebuilt
    }

    return zset
  }

  private lowerBoundByScore(entries: SortedSetEntry[], score: number): number {
    let low = 0
    let high = entries.length
    while (low < high) {
      const mid = (low + high) >>> 1
      if (entries[mid].score < score) low = mid + 1
      else high = mid
    }
    return low
  }

  private upperBoundByScore(entries: SortedSetEntry[], score: number): number {
    let low = 0
    let high = entries.length
    while (low < high) {
      const mid = (low + high) >>> 1
      if (entries[mid].score <= score) low = mid + 1
      else high = mid
    }
    return low
  }

  private insertionIndex(entries: SortedSetEntry[], entry: SortedSetEntry): number {
    let low = 0
    let high = entries.length
    while (low < high) {
      const mid = (low + high) >>> 1
      if (this.compareSortedSetEntries(entries[mid], entry) < 0) low = mid + 1
      else high = mid
    }
    return low
  }

  private parseSortedSetScore(value: number | string, fallbackInfinity: number): number {
    if (value === "-inf") return Number.NEGATIVE_INFINITY
    if (value === "+inf") return Number.POSITIVE_INFINITY
    const parsed = Number(value)
    return Number.isNaN(parsed) ? fallbackInfinity : parsed
  }
  
  private setKeyTTL(key: string, seconds: number): void {
    if (!this.data.ttl) {
      this.data.ttl = new Map()
    }
    this.data.ttl.set(key, Date.now() + seconds * 1000)
  }

  private trackOperation(): void {
    // Lightweight: just increment the counter. Rate is computed lazily on read.
    const stats = this.data.requestStats
    const nowSec = Math.floor(Date.now() / 1000)
    if (nowSec !== stats.lastSecond) {
      // New second window: snapshot ops/sec from previous window and reset
      stats.operationsPerSecond = stats.requestCount
      stats.requestCount = 0
      stats.lastSecond = nowSec
    }
    stats.requestCount++
  }

  async ping() {
    return "PONG"
  }

  async info(): Promise<string> {
    const totalKeys = await this.dbSize()
    return [`redis_version:local-inline`, `db0:keys=${totalKeys}`, `uptime_in_seconds:${Math.floor(process.uptime())}`].join("\n")
  }

  async get(key: string): Promise<string | null> {
    this.trackOperation()
    if (this.isExpired(key)) return null
    return this.data.strings.get(key) ?? null
  }

  async mget(...keys: string[]): Promise<Array<string | null>> {
    this.trackOperation()
    return keys.map((key) => {
      if (this.isExpired(key)) return null
      return this.data.strings.get(key) ?? null
    })
  }

  /**
   * Set a string value with optional TTL and atomic-acquire semantics.
   *
   * Returns `"OK"` on success, `null` when `NX` was requested and the key
   * already existed (Redis-standard). The previous `Promise<void>`
   * signature could not represent the "not acquired" case, which made it
   * impossible to build atomic locks on top of `client.set` —
   * `acquireLock`, the cron sweep guard, and other check-then-act
   * locations all silently raced because they had no way to learn
   * whether they actually won the slot.
   *
   * Options:
   *   - `EX`: TTL seconds (matches existing usage everywhere).
   *   - `NX`: only set if the key does NOT already exist. Combined with
   *     `EX` this is the canonical "atomic acquire-or-fail" primitive
   *     (`SET key val NX EX ttl`). When the key is already present we
   *     return `null` and DO NOT touch the value or refresh the TTL.
   *   - `XX`: only set if the key DOES exist (mirror of NX, for
   *     symmetry with the real Redis API surface).
   */
  async set(
    key: string,
    value: string,
    options?: { EX?: number; NX?: boolean; XX?: boolean },
  ): Promise<string | null> {
    this.trackOperation()
    if (options?.NX || options?.XX) {
      // Honour TTL on the existence-check too — an expired key counts
      // as "does not exist" for NX, and as "exists" for XX.
      const exists = !this.isExpired(key) && this.data.strings.has(key)
      if (options.NX && exists) return null
      if (options.XX && !exists) return null
    }
    this.data.strings.set(key, value)
    if (options?.EX) {
      this.setKeyTTL(key, options.EX)
    }
    return "OK"
  }
  
  async setex(key: string, seconds: number, value: string): Promise<void> {
    this.data.strings.set(key, value)
    this.setKeyTTL(key, seconds)
  }

  async incr(key: string): Promise<number> {
    return this.incrby(key, 1)
  }

  async incrby(key: string, increment: number): Promise<number> {
    if (this.isExpired(key)) {
      this.data.strings.set(key, String(increment))
      return increment
    }
    const current = parseInt(this.data.strings.get(key) || "0", 10)
    const newValue = current + increment
    this.data.strings.set(key, String(newValue))
    return newValue
  }

  async del(...keys: string[]): Promise<number> {
    let count = 0
    for (const key of keys) {
      const exists = this.data.strings.has(key) ||
        this.data.hashes.has(key) ||
        this.data.sets.has(key) ||
        this.data.lists.has(key) ||
        this.data.sorted_sets.has(key)

      if (exists) {
        this.deleteKey(key)
        count++
      }
    }
    return count
  }

  async flushDb(): Promise<void> {
    this.data.strings.clear()
    this.data.hashes.clear()
    this.data.sets.clear()
    this.data.lists.clear()
    this.data.sorted_sets.clear()
    this.data.ttl?.clear()
  }

  /**
   * Root-cause fix for "data still remaining after Reset DB".
   *
   * The previous clear-progressions route deleted keys from in-memory Maps
   * via `client.del(...)` but never updated the snapshot file on disk.
   * The next HTTP request triggers `loadFromDisk()` which restored all
   * deleted keys from the stale snapshot, making the reset appear to have
   * no effect. This method atomically deletes from memory AND overwrites
   * the snapshot so both layers stay consistent after a reset.
   *
   * Deletes all keys whose prefix is NOT in `protectedPrefixes`.
   * `forceClearPrefixes` overrides protection for runtime caches that
   * share a protected namespace (e.g. `connection:test:*`).
   */
  async flushRuntimeKeys(
    protectedPrefixes: readonly string[],
    forceClearPrefixes: readonly string[] = [],
  ): Promise<{ deleted: number; protected: number; buckets: Record<string, number> }> {
    const checkProtected = (key: string): boolean => {
      for (const fc of forceClearPrefixes) {
        if (key.startsWith(fc)) return false
      }
      for (const p of protectedPrefixes) {
        if (key.startsWith(p)) return true
      }
      return false
    }
    const bucketOf = (key: string): string => {
      const idx = key.indexOf(":")
      return idx > 0 ? key.slice(0, idx) + ":*" : key
    }
    const allKeys = new Set<string>([
      ...this.data.strings.keys(),
      ...this.data.hashes.keys(),
      ...this.data.sets.keys(),
      ...this.data.lists.keys(),
      ...this.data.sorted_sets.keys(),
    ])
    let deleted = 0
    let protectedCount = 0
    // Build bucket summary BEFORE deletion so the response reflects what
    // was actually removed — not what survived.
    const buckets: Record<string, number> = {}
    for (const key of allKeys) {
      if (checkProtected(key)) {
        protectedCount++
      } else {
        const b = bucketOf(key)
        buckets[b] = (buckets[b] || 0) + 1
        this.deleteKey(key)
        deleted++
      }
    }
    if (this.data.ttl) {
      for (const key of this.data.ttl.keys()) {
        if (!checkProtected(key)) this.data.ttl.delete(key)
      }
    }
    // Immediately overwrite the snapshot so loadFromDisk() on the next
    // cold-start or hot-reload only restores protected keys. Without this
    // step, a hot-reload or cold-start resurrects the deleted runtime data.
    await this.saveToDisk()
    return { deleted, protected: protectedCount, buckets }
  }

  /**
   * Flush the in-memory state to disk without any deletions.
   * Call this after any batch of writes that MUST be durable before the
   * next request (e.g. after connection-flag resets in clear-progressions).
   */
  async persistNow(): Promise<boolean> {
    return this.saveToDisk()
  }

  async hset(key: string, dataOrField: Record<string, string> | string, value?: string): Promise<number> {
    this.trackOperation()
    const existing = this.data.hashes.get(key) || {}
    // Support both hset(key, { field: value }) and hset(key, "field", "value")
    if (typeof dataOrField === "string" && value !== undefined) {
      this.data.hashes.set(key, { ...existing, [dataOrField]: value })
      return 1
    }
    const data = dataOrField as Record<string, string>
    const updates = Object.keys(data).length
    this.data.hashes.set(key, { ...existing, ...data })
    return updates
  }

  async hmset(...args: string[]): Promise<void> {
    this.trackOperation()
    if (args.length < 3) return
    const key = args[0]
    const obj: Record<string, string> = {}
    for (let i = 1; i < args.length; i += 2) {
      obj[args[i]] = args[i + 1]
    }
    this.data.hashes.set(key, { ...this.data.hashes.get(key), ...obj })
  }

  async hgetall(key: string): Promise<Record<string, string>> {
    this.trackOperation()
    // REAL REDIS SEMANTICS: node-redis hGetAll returns {} for missing keys,
    // never null. The previous null return deviated from that and caused an
    // entire class of "Cannot read properties of null" crashes in callers
    // that (correctly, per redis docs) did not null-check.
    // Also return a SHALLOW COPY — returning the live hash reference let
    // callers that mutate the result silently corrupt the in-memory store.
    if (this.isExpired(key)) return {}
    const hash = this.data.hashes.get(key)
    return hash ? { ...hash } : {}
  }

  async hlen(key: string): Promise<number> {
    const hash = this.data.hashes.get(key)
    return hash ? Object.keys(hash).length : 0
  }

  async hget(key: string, field: string): Promise<string | null> {
    if (this.isExpired(key)) return null
    const hash = this.data.hashes.get(key)
    return hash?.[field] ?? null
  }

  async hdel(key: string, ...fields: string[]): Promise<number> {
    const hash = this.data.hashes.get(key)
    if (!hash) return 0
    let deleted = 0
    for (const field of fields) {
      if (field in hash) {
        delete hash[field]
        deleted++
      }
    }
    if (Object.keys(hash).length === 0) {
      this.data.hashes.delete(key)
    }
    return deleted
  }

  async hincrby(key: string, field: string, increment: number): Promise<number> {
    const hash = this.data.hashes.get(key) || {}
    const currentValue = parseInt(hash[field] || "0", 10)
    const newValue = currentValue + increment
    hash[field] = String(newValue)
    this.data.hashes.set(key, hash)
    return newValue
  }

  async hincrbyfloat(key: string, field: string, increment: number): Promise<number> {
    const hash = this.data.hashes.get(key) || {}
    const currentValue = parseFloat(hash[field] || "0")
    const newValue = currentValue + increment
    hash[field] = String(newValue)
    this.data.hashes.set(key, hash)
    return newValue
  }

  async sadd(key: string, ...members: string[]): Promise<number> {
    this.trackOperation()
    const set = this.data.sets.get(key) || new Set()
    const sizeBefore = set.size
    for (const member of members) {
      if (member) set.add(member)
    }
    this.data.sets.set(key, set)
    return set.size - sizeBefore
  }

  async scard(key: string): Promise<number> {
    if (this.isExpired(key)) return 0
    return this.data.sets.get(key)?.size ?? 0
  }

  async smembers(key: string): Promise<string[]> {
    this.trackOperation()
    if (this.isExpired(key)) return []
    return Array.from(this.data.sets.get(key) || new Set())
  }

  async sismember(key: string, member: string): Promise<number> {
    if (this.isExpired(key)) return 0
    const set = this.data.sets.get(key)
    return set?.has(member) ? 1 : 0
  }

  async srem(key: string, ...members: string[]): Promise<number> {
    const set = this.data.sets.get(key)
    if (!set) return 0
    let removed = 0
    for (const member of members) {
      if (set.delete(member)) removed++
    }
    if (set.size === 0) this.data.sets.delete(key)
    else this.data.sets.set(key, set)
    return removed
  }

  async expire(key: string, seconds: number): Promise<number> {
    const exists = this.data.strings.has(key) || 
                   this.data.hashes.has(key) || 
                   this.data.sets.has(key) ||
                   this.data.lists.has(key) ||
                   this.data.sorted_sets.has(key)
    if (exists) {
      this.setKeyTTL(key, seconds)
      return 1
    }
    return 0
  }

  async lpush(key: string, ...values: string[]): Promise<number> {
    const list = this.data.lists.get(key) || []
    for (const value of values) {
      list.unshift(value)
    }
    this.data.lists.set(key, list)
    return list.length
  }

  async rpush(key: string, ...values: string[]): Promise<number> {
    const list = this.data.lists.get(key) || []
    list.push(...values)
    this.data.lists.set(key, list)
    return list.length
  }

  async lrange(key: string, start: number, stop: number): Promise<string[]> {
    if (this.isExpired(key)) return []
    const list = this.data.lists.get(key) || []
    const len = list.length
    const normalizedStart = start < 0 ? Math.max(0, len + start) : start
    const normalizedStop = stop < 0 ? len + stop : stop
    return list.slice(normalizedStart, normalizedStop + 1)
  }

  async ltrim(key: string, start: number, stop: number): Promise<void> {
    const list = this.data.lists.get(key)
    if (!list) return
    const len = list.length
    const normalizedStart = start < 0 ? Math.max(0, len + start) : start
    const normalizedStop = stop < 0 ? len + stop : stop
    const trimmed = list.slice(normalizedStart, normalizedStop + 1)
    this.data.lists.set(key, trimmed)
  }

  async llen(key: string): Promise<number> {
    if (this.isExpired(key)) return 0
    return this.data.lists.get(key)?.length ?? 0
  }

  /**
   * Remove `count` occurrences of `value` from the list at `key`.
   * Semantics match Redis `LREM`:
   *   count > 0 — remove head��tail
   *   count < 0 — remove tail→head
   *   count = 0 — remove every occurrence
   *
   * Previously this method didn't exist on the in-memory adapter, which made
   * `live-stage.savePosition()` throw `TypeError: client.lrem is not a function`
   * on every position close and prevented the closed-index bookkeeping from
   * running. That in turn made `getLivePositions` re-scan terminal rows
   * forever and is visible in the server logs at live-stage.ts:156.
   */
  async lrem(key: string, count: number, value: string): Promise<number> {
    if (this.isExpired(key)) return 0
    const list = this.data.lists.get(key)
    if (!list || list.length === 0) return 0
    let removed = 0
    const wantAll = count === 0
    const target = Math.abs(count)
    if (count >= 0) {
      for (let i = 0; i < list.length; ) {
        if (list[i] === value && (wantAll || removed < target)) {
          list.splice(i, 1)
          removed++
        } else {
          i++
        }
      }
    } else {
      for (let i = list.length - 1; i >= 0; i--) {
        if (list[i] === value && (wantAll || removed < target)) {
          list.splice(i, 1)
          removed++
        }
      }
    }
    if (list.length === 0) {
      this.data.lists.delete(key)
    } else {
      this.data.lists.set(key, list)
    }
    return removed
  }

  /**
   * Return the zero-based index of the first matching list element, or null.
   * Mirrors Redis LPOS for the subset of behavior used by live position
   * archive deduplication.
   */
  async lpos(key: string, value: string): Promise<number | null> {
    if (this.isExpired(key)) return null
    const list = this.data.lists.get(key)
    if (!list || list.length === 0) return null
    const index = list.indexOf(value)
    return index >= 0 ? index : null
  }

  /**
   * Pop and return the first element of the list at `key`. Returns null when
   * the list is empty or missing. Added for parity with `lpush`/`rpush` so
   * upstream callers that move items between queues don't blow up.
   */
  async lpop(key: string): Promise<string | null> {
    if (this.isExpired(key)) return null
    const list = this.data.lists.get(key)
    if (!list || list.length === 0) return null
    const head = list.shift() ?? null
    if (list.length === 0) this.data.lists.delete(key)
    return head
  }

  async rpop(key: string): Promise<string | null> {
    if (this.isExpired(key)) return null
    const list = this.data.lists.get(key)
    if (!list || list.length === 0) return null
    const tail = list.pop() ?? null
    if (list.length === 0) this.data.lists.delete(key)
    return tail
  }

  async dbSize(): Promise<number> {
    return this.data.strings.size + this.data.hashes.size + this.data.sets.size + this.data.lists.size + this.data.sorted_sets.size
  }

  async keys(pattern: string): Promise<string[]> {
    const regexPattern = pattern
      .replace(/\*/g, ".*")
      .replace(/\?/g, ".")
    const regex = new RegExp(`^${regexPattern}$`)

    const uniqueKeys = new Set<string>()
    const keyCollections = [
      this.data.strings.keys(),
      this.data.hashes.keys(),
      this.data.sets.keys(),
      this.data.lists.keys(),
      this.data.sorted_sets.keys(),
    ]

    for (const collection of keyCollections) {
      for (const key of collection) {
        if (this.isExpired(key)) continue
        if (regex.test(key)) uniqueKeys.add(key)
      }
    }

    return Array.from(uniqueKeys)
  }

  async zadd(key: string, score: number, member: string): Promise<number> {
    const zset = this.getSortedSet(key) || this.createSortedSet()
    const existing = zset.memberIndex.get(member)
    const entry = { score, member }

    if (existing) {
      const existingIndex = this.insertionIndex(zset.entries, existing)
      if (zset.entries[existingIndex]?.member === member) {
        zset.entries.splice(existingIndex, 1)
      }
      zset.memberIndex.set(member, entry)
      zset.entries.splice(this.insertionIndex(zset.entries, entry), 0, entry)
      this.data.sorted_sets.set(key, zset)
      return 0
    }

    zset.memberIndex.set(member, entry)
    zset.entries.splice(this.insertionIndex(zset.entries, entry), 0, entry)
    this.data.sorted_sets.set(key, zset)
    return 1
  }

  async zrangebyscore(key: string, min: number | string, max: number | string): Promise<string[]> {
    if (this.isExpired(key)) return []
    const entries = this.getSortedSet(key)?.entries || []
    const minValue = this.parseSortedSetScore(min, Number.NEGATIVE_INFINITY)
    const maxValue = this.parseSortedSetScore(max, Number.POSITIVE_INFINITY)
    const start = this.lowerBoundByScore(entries, minValue)
    const end = this.upperBoundByScore(entries, maxValue)
    return entries.slice(start, end).map((entry) => entry.member)
  }

  async zremrangebyscore(key: string, min: number | string, max: number | string): Promise<number> {
    const zset = this.getSortedSet(key)
    if (!zset) return 0
    const minValue = this.parseSortedSetScore(min, Number.NEGATIVE_INFINITY)
    const maxValue = this.parseSortedSetScore(max, Number.POSITIVE_INFINITY)
    const start = this.lowerBoundByScore(zset.entries, minValue)
    const end = this.upperBoundByScore(zset.entries, maxValue)
    const removed = zset.entries.slice(start, end)
    if (removed.length === 0) return 0
    for (const entry of removed) zset.memberIndex.delete(entry.member)
    zset.entries.splice(start, removed.length)
    if (zset.entries.length === 0) this.data.sorted_sets.delete(key)
    else this.data.sorted_sets.set(key, zset)
    return removed.length
  }

  /** Return members in ascending score order between indices start and stop (inclusive). */
  async zrange(key: string, start: number, stop: number): Promise<string[]> {
    if (this.isExpired(key)) return []
    const entries = this.getSortedSet(key)?.entries || []
    const end = stop < 0 ? entries.length + stop + 1 : stop + 1
    return entries.slice(start < 0 ? Math.max(0, entries.length + start) : start, end).map(e => e.member)
  }

  /** Return members in descending score order between indices start and stop (inclusive). */
  async zrevrange(key: string, start: number, stop: number): Promise<string[]> {
    if (this.isExpired(key)) return []
    const entries = this.getSortedSet(key)?.entries || []
    const reversed = [...entries].reverse()
    const end = stop < 0 ? reversed.length + stop + 1 : stop + 1
    return reversed.slice(start < 0 ? Math.max(0, reversed.length + start) : start, end).map(e => e.member)
  }

  /** Return the score of a member in a sorted set. */
  async zscore(key: string, member: string): Promise<string | null> {
    if (this.isExpired(key)) return null
    const entry = this.getSortedSet(key)?.memberIndex.get(member)
    return entry !== undefined ? String(entry.score) : null
  }

  /** Return the cardinality (number of members) of a sorted set. */
  async zcard(key: string): Promise<number> {
    if (this.isExpired(key)) return 0
    return (this.getSortedSet(key)?.entries || []).length
  }

  async trackDatabaseOperation(limit: number): Promise<{ current: number; limit: number; exceeded: boolean }> {
    const globalTracker = globalThis as unknown as { __db_ops_tracker?: { timestamp: number; count: number } }
    const now = Date.now()
    
    if (!globalTracker.__db_ops_tracker) {
      globalTracker.__db_ops_tracker = { timestamp: now, count: 0 }
    }
    
    const tracker = globalTracker.__db_ops_tracker
    const windowStart = now - 60000
    
    if (tracker.timestamp < windowStart) {
      tracker.timestamp = now
      tracker.count = 0
    }
    
    tracker.count++
    tracker.timestamp = now
    
    return {
      current: tracker.count,
      limit: limit,
      exceeded: limit > 0 && tracker.count > limit,
    }
  }

  async getDatabaseOperationCount(): Promise<number> {
    const globalTracker = globalThis as unknown as { __db_ops_tracker?: { timestamp: number; count: number } }
    if (!globalTracker.__db_ops_tracker) return 0
    
    const now = Date.now()
    const windowStart = now - 60000
    
    if (globalTracker.__db_ops_tracker.timestamp < windowStart) {
      return 0
    }
    
    return globalTracker.__db_ops_tracker.count
  }

  async load(): Promise<void> {
    // No-op: data is already in global memory
  }

  async cleanupExpiredKeysPublic(): Promise<number> {
    return this.cleanupExpiredKeys()
  }

  async exists(key: string): Promise<number> {
    const exists = this.data.strings.has(key) || 
                   this.data.hashes.has(key) || 
                   this.data.sets.has(key) ||
                   this.data.lists.has(key) ||
                   this.data.sorted_sets.has(key)
    return exists ? 1 : 0
  }

  async ttl(key: string): Promise<number> {
    const ttlMap = this.data.ttl
    if (!ttlMap || !ttlMap.has(key)) {
      const existsResult = await this.exists(key)
      if (existsResult === 0) return -2
      return -1
    }
    
    const expireAt = ttlMap.get(key)!
    const now = Date.now()
    if (now >= expireAt) {
      return -2
    }
    
    return Math.floor((expireAt - now) / 1000)
  }

  /**
   * Pipeline / MULTI compatibility shim.
   *
   * The in-memory `InlineLocalRedis` has zero network round-trips — every
   * op resolves in microseconds against a `Map`. Real pipelining (batching
   * commands into one RTT) is therefore meaningless for this backend.
   * BUT several call sites (and every real Upstash/ioredis client in the
   * wild) expect a chainable `client.multi()` that queues commands and
   * executes them on `.exec()`. Without a compatible shim here, callers
   * crash with "client.multi is not a function" and — because most of
   * those call sites wrap in try/catch that swallow errors — the failures
   * go undetected (e.g. prefetchMarketDataBatch, close-path pipelines).
   *
   * This shim records `(method, args)` pairs and dispatches them
   * sequentially on `.exec()` via the real method on the same instance,
   * returning an array of results in order — same contract as upstash's
   * and ioredis's pipeline APIs. Sequential execution is correct (Map
   * ops are synchronous) and still zero-RTT. If this project ever swaps
   * in a network Redis client, the caller code is already shaped for a
   * real pipeline.
   */
  multi(): {
    [k: string]: any
    exec: () => Promise<any[]>
  } {
    const ops: Array<{ method: string; args: any[] }> = []
    const self = this as unknown as Record<string, any>
    const queue = new Proxy(
      {},
      {
        get: (_target, prop: string) => {
          if (prop === "exec") {
            return async (): Promise<any[]> => {
              const results: any[] = []
              for (const { method, args } of ops) {
                const fn = self[method]
                if (typeof fn !== "function") {
                  // Unknown command: push a null result so caller index
                  // alignment isn't broken.
                  results.push(null)
                  continue
                }
                try {
                  results.push(await fn.apply(self, args))
                } catch (err) {
                  // Match upstash/ioredis: include the error per-slot.
                  results.push(err)
                }
              }
              return results
            }
          }
          // Chainable command recorder.
          return (...args: any[]) => {
            ops.push({ method: prop, args })
            return queue
          }
        },
      },
    ) as { [k: string]: any; exec: () => Promise<any[]> }
    return queue
  }

  /**
   * Alias for `multi()` — upstash-redis's client exposes both names. Keeps
   * any caller that happened to standardize on `pipeline()` working.
   */
  pipeline(): ReturnType<InlineLocalRedis["multi"]> {
    return this.multi()
  }
}


function hasSharedRedisConfig(): boolean {
  return !!(
    process.env.REDIS_URL ||
    (process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN) ||
    process.env.KV_URL ||
    (process.env.KV_REST_API_URL && process.env.KV_REST_API_TOKEN)
  )
}

class NodeRedisClientAdapter implements RedisClientLike {
  private client: any | null = null
  private connectPromise: Promise<any> | null = null
  constructor(private readonly url: string) {}
  private async c(): Promise<any> {
    if (this.client) return this.client
    if (!this.connectPromise) {
      this.connectPromise = import("redis").then(async ({ createClient }) => {
        const client = createClient({ url: this.url })
        client.on?.("error", (err: unknown) => console.error("[v0] [Redis] network client error:", err))
        await client.connect()
        this.client = client
        return client
      }).finally(() => { this.connectPromise = null })
    }
    return this.connectPromise
  }
  async ping() { return String(await (await this.c()).ping()) }
  async info() { return String(await (await this.c()).info()) }
  async get(key: string) { return await (await this.c()).get(key) }
  async mget(...keys: string[]) { return await (await this.c()).mGet(keys) }
  async set(key: string, value: string, options?: { EX?: number; NX?: boolean; XX?: boolean }) { return await (await this.c()).set(key, value, options as any) }
  async setex(key: string, seconds: number, value: string) { return await (await this.c()).setEx(key, seconds, value) }
  async incr(key: string) { return await (await this.c()).incr(key) }
  async incrby(key: string, increment: number) { return await (await this.c()).incrBy(key, increment) }
  async del(...keys: string[]) { return await (await this.c()).del(keys) }
  async flushDb() { await (await this.c()).flushDb() }
  async hset(key: string, dataOrField: Record<string, string> | string, value?: string) { return typeof dataOrField === "string" ? await (await this.c()).hSet(key, dataOrField, value ?? "") : await (await this.c()).hSet(key, dataOrField) }
  async hmset(...args: string[]) { const [key, ...rest] = args; const obj: Record<string, string> = {}; for (let i = 0; i < rest.length; i += 2) obj[rest[i]] = rest[i + 1]; await this.hset(key, obj) }
  async hgetall(key: string) { return await (await this.c()).hGetAll(key) }
  async hlen(key: string) { return await (await this.c()).hLen(key) }
  async hget(key: string, field: string) { return await (await this.c()).hGet(key, field) }
  async hdel(key: string, ...fields: string[]) { return await (await this.c()).hDel(key, fields) }
  async hincrby(key: string, field: string, increment: number) { return await (await this.c()).hIncrBy(key, field, increment) }
  async hincrbyfloat(key: string, field: string, increment: number) { return await (await this.c()).hIncrByFloat(key, field, increment) }
  async sadd(key: string, ...members: string[]) { return await (await this.c()).sAdd(key, members) }
  async scard(key: string) { return await (await this.c()).sCard(key) }
  async smembers(key: string) { return await (await this.c()).sMembers(key) }
  async sismember(key: string, member: string) { return await (await this.c()).sIsMember(key, member) ? 1 : 0 }
  async srem(key: string, ...members: string[]) { return await (await this.c()).sRem(key, members) }
  async expire(key: string, seconds: number) { return await (await this.c()).expire(key, seconds) }
  async lpush(key: string, ...values: string[]) { return await (await this.c()).lPush(key, values) }
  async rpush(key: string, ...values: string[]) { return await (await this.c()).rPush(key, values) }
  async lrange(key: string, start: number, stop: number) { return await (await this.c()).lRange(key, start, stop) }
  async ltrim(key: string, start: number, stop: number) { await (await this.c()).lTrim(key, start, stop) }
  async llen(key: string) { return await (await this.c()).lLen(key) }
  async lrem(key: string, count: number, value: string) { return await (await this.c()).lRem(key, count, value) }
  async lpos(key: string, value: string) { return await (await this.c()).lPos(key, value) }
  async lpop(key: string) { return await (await this.c()).lPop(key) }
  async rpop(key: string) { return await (await this.c()).rPop(key) }
  async eval(script: string, options: { keys: string[]; arguments: string[] }) { return await (await this.c()).eval(script, options) }
  async dbSize() { return await (await this.c()).dbSize() }
  async keys(pattern: string) { return await (await this.c()).keys(pattern) }
  async zadd(key: string, score: number, member: string) { return await (await this.c()).zAdd(key, { score, value: member }) }
  async zrangebyscore(key: string, min: number | string, max: number | string) { return await (await this.c()).zRangeByScore(key, min as any, max as any) }
  async zremrangebyscore(key: string, min: number | string, max: number | string) { return await (await this.c()).zRemRangeByScore(key, min as any, max as any) }
  async zrange(key: string, start: number, stop: number) { return await (await this.c()).zRange(key, start, stop) }
  async zrevrange(key: string, start: number, stop: number) { return await (await this.c()).zRange(key, start, stop, { REV: true } as any) }
  async zscore(key: string, member: string) { const score = await (await this.c()).zScore(key, member); return score == null ? null : String(score) }
  async zcard(key: string) { return await (await this.c()).zCard(key) }
  async exists(key: string) { return await (await this.c()).exists(key) }
  async ttl(key: string) { return await (await this.c()).ttl(key) }
  async saveToDisk() { return false }
  async loadFromDisk() { return false }
  saveToDiskSync() { return false }
  async persistNow() { return false }
  async cleanupExpiredKeysPublic() { return 0 }
  async trackDatabaseOperation(limit: number) { return { current: 0, limit, exceeded: false } }
  async getDatabaseOperationCount() { return 0 }
  multi() {
    const ops: Array<{ method: string; args: any[] }> = []
    const self = this as unknown as Record<string, any>
    const queue = new Proxy({}, {
      get: (_target, prop: string) => {
        if (prop === "exec") {
          return async () => {
            const client = await this.c()
            if (typeof client.multi === "function") {
              const tx = client.multi()
              for (const { method, args } of ops) {
                if (typeof tx[method] === "function") tx[method](...args)
              }
              return tx.exec()
            }
            const results: any[] = []
            for (const { method, args } of ops) results.push(await self[method]?.(...args))
            return results
          }
        }
        return (...args: any[]) => { ops.push({ method: prop, args }); return queue }
      },
    }) as { [k: string]: any; exec: () => Promise<any[]> }
    return queue
  }
  pipeline() { return this.multi() }
}


class UpstashRestRedisClient implements RedisClientLike {
  constructor(private readonly url: string, private readonly token: string) {}
  private async command<T = any>(command: Array<string | number>): Promise<T> {
    const response = await fetch(this.url.replace(/\/$/, "") + "/pipeline", {
      method: "POST",
      headers: { Authorization: `Bearer ${this.token}`, "Content-Type": "application/json" },
      body: JSON.stringify([command]),
    })
    if (!response.ok) throw new Error(`Upstash Redis command failed: ${response.status} ${response.statusText}`)
    const payload = await response.json()
    const item = Array.isArray(payload) ? payload[0] : payload
    if (item?.error) throw new Error(String(item.error))
    return item?.result as T
  }
  async ping() { return String(await this.command(["PING"])) }
  async info() { return "redis_version:upstash-rest" }
  async get(key: string) { return await this.command<string | null>(["GET", key]) }
  async mget(...keys: string[]) { return await this.command<Array<string | null>>(["MGET", ...keys]) }
  async set(key: string, value: string, options?: { EX?: number; NX?: boolean; XX?: boolean }) { const cmd: Array<string | number> = ["SET", key, value]; if (options?.NX) cmd.push("NX"); if (options?.XX) cmd.push("XX"); if (options?.EX) cmd.push("EX", options.EX); return await this.command<string | null>(cmd) }
  async setex(key: string, seconds: number, value: string) { await this.command(["SETEX", key, seconds, value]) }
  async incr(key: string) { return await this.command<number>(["INCR", key]) }
  async incrby(key: string, increment: number) { return await this.command<number>(["INCRBY", key, increment]) }
  async del(...keys: string[]) { return await this.command<number>(["DEL", ...keys]) }
  async flushDb() { await this.command(["FLUSHDB"]) }
  async hset(key: string, dataOrField: Record<string, string> | string, value?: string) { const cmd: Array<string | number> = ["HSET", key]; if (typeof dataOrField === "string") cmd.push(dataOrField, value ?? ""); else for (const [f, v] of Object.entries(dataOrField)) cmd.push(f, v); return await this.command<number>(cmd) }
  async hmset(...args: string[]) { await this.command(["HSET", ...args]) }
  async hgetall(key: string) { const result = await this.command<any>(["HGETALL", key]); if (!Array.isArray(result)) return result || {}; const obj: Record<string, string> = {}; for (let i = 0; i < result.length; i += 2) obj[String(result[i])] = String(result[i + 1]); return obj }
  async hlen(key: string) { return await this.command<number>(["HLEN", key]) }
  async hget(key: string, field: string) { return await this.command<string | null>(["HGET", key, field]) }
  async hdel(key: string, ...fields: string[]) { return await this.command<number>(["HDEL", key, ...fields]) }
  async hincrby(key: string, field: string, increment: number) { return await this.command<number>(["HINCRBY", key, field, increment]) }
  async hincrbyfloat(key: string, field: string, increment: number) { return await this.command<number>(["HINCRBYFLOAT", key, field, increment]) }
  async sadd(key: string, ...members: string[]) { return await this.command<number>(["SADD", key, ...members]) }
  async scard(key: string) { return await this.command<number>(["SCARD", key]) }
  async smembers(key: string) { return await this.command<string[]>(["SMEMBERS", key]) }
  async sismember(key: string, member: string) { return await this.command<number>(["SISMEMBER", key, member]) }
  async srem(key: string, ...members: string[]) { return await this.command<number>(["SREM", key, ...members]) }
  async expire(key: string, seconds: number) { return await this.command<number>(["EXPIRE", key, seconds]) }
  async lpush(key: string, ...values: string[]) { return await this.command<number>(["LPUSH", key, ...values]) }
  async rpush(key: string, ...values: string[]) { return await this.command<number>(["RPUSH", key, ...values]) }
  async lrange(key: string, start: number, stop: number) { return await this.command<string[]>(["LRANGE", key, start, stop]) }
  async ltrim(key: string, start: number, stop: number) { await this.command(["LTRIM", key, start, stop]) }
  async llen(key: string) { return await this.command<number>(["LLEN", key]) }
  async lrem(key: string, count: number, value: string) { return await this.command<number>(["LREM", key, count, value]) }
  async lpos(key: string, value: string) { return await this.command<number | null>(["LPOS", key, value]) }
  async lpop(key: string) { return await this.command<string | null>(["LPOP", key]) }
  async rpop(key: string) { return await this.command<string | null>(["RPOP", key]) }
  async eval(script: string, options: { keys: string[]; arguments: string[] }) { return await this.command<any>(["EVAL", script, options.keys.length, ...options.keys, ...options.arguments]) }
  async dbSize() { return await this.command<number>(["DBSIZE"]) }
  async keys(pattern: string) { return await this.command<string[]>(["KEYS", pattern]) }
  async zadd(key: string, score: number, member: string) { return await this.command<number>(["ZADD", key, score, member]) }
  async zrangebyscore(key: string, min: number | string, max: number | string) { return await this.command<string[]>(["ZRANGEBYSCORE", key, min, max]) }
  async zremrangebyscore(key: string, min: number | string, max: number | string) { return await this.command<number>(["ZREMRANGEBYSCORE", key, min, max]) }
  async zrange(key: string, start: number, stop: number) { return await this.command<string[]>(["ZRANGE", key, start, stop]) }
  async zrevrange(key: string, start: number, stop: number) { return await this.command<string[]>(["ZREVRANGE", key, start, stop]) }
  async zscore(key: string, member: string) { const score = await this.command<string | number | null>(["ZSCORE", key, member]); return score == null ? null : String(score) }
  async zcard(key: string) { return await this.command<number>(["ZCARD", key]) }
  async exists(key: string) { return await this.command<number>(["EXISTS", key]) }
  async ttl(key: string) { return await this.command<number>(["TTL", key]) }
  async saveToDisk() { return false }
  async loadFromDisk() { return false }
  saveToDiskSync() { return false }
  async persistNow() { return false }
  async cleanupExpiredKeysPublic() { return 0 }
  async trackDatabaseOperation(limit: number) { return { current: 0, limit, exceeded: false } }
  async getDatabaseOperationCount() { return 0 }
  multi() { const ops: Array<Array<string | number>> = []; const queue = new Proxy({}, { get: (_t, prop: string) => prop === "exec" ? async () => Promise.all(ops.map((op) => this.command(op))) : (...args: Array<string | number>) => { ops.push([prop.toUpperCase(), ...args]); return queue } }) as { [k: string]: any; exec: () => Promise<any[]> }; return queue }
  pipeline() { return this.multi() }
}

function createRedisInstance(): RedisClientLike {
  const url = process.env.REDIS_URL || process.env.KV_URL
  if (url) {
    globalForRedis.__redis_backend = "redis-network"
    return new NodeRedisClientAdapter(url)
  }
  const restUrl = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL
  const restToken = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN
  if (restUrl && restToken) {
    globalForRedis.__redis_backend = "redis-network"
    return new UpstashRestRedisClient(restUrl, restToken)
  }
  if (isProductionEnvironment() && !hasSharedRedisConfig()) {
    const strict = process.env.STRICT_REDIS_REQUIRED === "1" || process.env.REQUIRE_SHARED_REDIS === "1"
    if (strict) {
      throw new Error("Production Redis configuration missing: set REDIS_URL, KV_URL, or Upstash REST env vars for shared Redis")
    }
    console.warn(
      "[v0] [Redis] Production Redis configuration missing; falling back to InlineLocalRedis. " +
        "Set REDIS_URL/KV_URL/Upstash env vars for shared durable storage, or STRICT_REDIS_REQUIRED=1 to fail fast.",
    )
  }
  globalForRedis.__redis_backend = "inline-local"
  return new InlineLocalRedis()
}

export function getRedisBackend(): RedisBackend {
  return globalForRedis.__redis_backend || (redisInstance instanceof InlineLocalRedis ? "inline-local" : "redis-network")
}

let redisInstance: RedisClientLike | null = null
let isConnected = false          // FULLY ready: core + migrations complete
let coreInitialized = false      // core ready: client constructed + snapshot loaded + ping ok
let connectionsInitialized = false
let migrationsRan = false

function isNextBuildPhase(): boolean {
  const lifecycle = process.env.npm_lifecycle_event || ""
  const argv = process.argv.join(" ")
  return (
    process.env.NEXT_PHASE === "phase-production-build" ||
    lifecycle === "build" ||
    lifecycle === "vercel-build" ||
    /\bnext(\.js)?\s+build\b/.test(argv)
  )
}

/**
 * Ensure the CORE Redis client is ready: instance constructed, on-disk
 * snapshot loaded, and ping verified. This deliberately does NOT run
 * migrations.
 *
 * `runMigrations()` (in redis-migrations.ts) calls THIS — never initRedis() —
 * to bring the store up. That breaks what would otherwise be a deadlock:
 * initRedis() awaits a shared promise whose body awaits runMigrations(); if
 * runMigrations() awaited initRedis() it would await the very promise it is
 * running inside. Splitting core init out removes the cycle entirely.
 *
 * Idempotent and concurrency-safe: a single core-init promise is shared
 * across all callers/module scopes via globalForRedis.
 */
export async function ensureCoreRedis(): Promise<void> {
  if (coreInitialized && redisInstance) return
  if (globalForRedis.__redis_core_promise) return globalForRedis.__redis_core_promise

  globalForRedis.__redis_core_promise = (async () => {
    // Ensure the instance exists. A sync getter (getRedisClient/getClient) may
    // have constructed it already; the constructor only initialises empty Maps
    // and never loads the snapshot — that is done explicitly below.
    if (!redisInstance) {
      redisInstance = createRedisInstance()
    }

    // Load the on-disk snapshot EXACTLY ONCE per process, gated on the global
    // snapshot flag. If a sync getter built the instance and callers already
    // wrote data before initRedis(), do not reload from disk over those live
    // writes; mark the snapshot as handled instead. This keeps tests and
    // pre-init bootstrap code from having settings overwritten by a stale
    // dev snapshot while still loading snapshots for truly empty instances.
    if (!globalForRedis.__redis_snapshot_loaded) {
      const existingKeys = await redisInstance.dbSize().catch(() => 0)
      if (existingKeys > 0) {
        globalForRedis.__redis_snapshot_loaded = true
      } else {
        if (!globalForRedis.__redis_load_promise) {
          globalForRedis.__redis_load_promise = redisInstance instanceof InlineLocalRedis ? redisInstance
            .loadFromDisk()
            .then((ok) => { globalForRedis.__redis_snapshot_loaded = true; return ok })
            .catch(() => { globalForRedis.__redis_snapshot_loaded = true; return false }) : Promise.resolve(false).then((ok) => { globalForRedis.__redis_snapshot_loaded = true; return ok })
          globalForRedis.__redis_load_promise.finally(() => {
            globalForRedis.__redis_load_promise = undefined
          })
        }
        await globalForRedis.__redis_load_promise
      }
    }

    const pong = await redisInstance.ping()
    if (pong !== "PONG") {
      console.error("[v0] [Redis] Connection test failed")
    }
    coreInitialized = true
  })()

  try {
    await globalForRedis.__redis_core_promise
  } finally {
    // Always clear: on success coreInitialized guards the fast path; on failure
    // the next caller must be able to retry from scratch.
    globalForRedis.__redis_core_promise = undefined
  }
}


export async function cleanupVolatileRuntimeState({
  reason = "startup",
}: { mode?: string; reason?: string } = {}): Promise<{ deleted: number; preserved: number }> {
  const client = getRedisClient()
  if (typeof (client as any).cleanupVolatileRuntimeState === "function") {
    return (client as any).cleanupVolatileRuntimeState({ reason })
  }

  const staleMs = Number(process.env.VOLATILE_STATE_STALE_MS || process.env.REDIS_VOLATILE_STALE_MS || 6 * 60 * 60 * 1000)
  const now = Date.now()
  const allKeys = await client.keys("*").catch(() => [] as string[])
  const toDelete: string[] = []
  let preserved = 0

  const staleStringKey = async (key: string) => {
    const [raw, ttl] = await Promise.all([
      client.get(key).catch(() => null),
      typeof (client as any).ttl === "function" ? (client as any).ttl(key).catch(() => -1) : Promise.resolve(-1),
    ])
    const ts = Number(raw || "")
    return ttl === -2 || (!Number.isFinite(ts) || ts <= 0 ? ttl < 0 : now - ts > staleMs)
  }

  for (const key of allKeys) {
    let del = false
    if (key.startsWith("live:position:") || key.startsWith("live:positions:") || key.startsWith("settings:live:")) {
      del = key.startsWith("live:position:tracking:") || key.includes(":moved:")
    } else if (key.startsWith("live:lock:") || key.startsWith("prehistoric_loaded:") || key.startsWith("prehistoric:progress:")) {
      del = await staleStringKey(key)
    } else if (
      key.startsWith("pseudo_position:") || key.startsWith("pseudo_positions:") ||
      key.startsWith("settings:pseudo_position") || key.startsWith("settings:pseudo_positions:") ||
      key.startsWith("indication_set:") || key.startsWith("indication_outcomes_pending:") ||
      key.startsWith("strategies:") || key.startsWith("settings:strategies")
    ) {
      del = true
    }
    if (del) toDelete.push(key)
    else preserved++
  }

  let deleted = 0
  for (let i = 0; i < toDelete.length; i += 500) {
    deleted += await client.del(...toDelete.slice(i, i + 500)).catch(() => 0)
  }
  if (deleted > 0) console.log(`[v0] [Redis] Volatile startup cleanup (${reason}): deleted ${deleted} keys, preserved ${preserved}`)
  return { deleted, preserved }
}

/**
 * Full initialisation: core Redis + schema migrations. `isConnected` only
 * becomes true AFTER migrations have completed, and every caller awaits the
 * SAME shared promise. This closes the cold-start race where isConnected
 * flipped true before migrations ran, letting concurrent route handlers read
 * un-migrated data. Identical behaviour in dev (`next dev`) and production
 * (`next start` / Vercel) — both invoke instrumentation.register() which calls
 * this, and every server action / route guards on it via ensureRedisInitialized.
 */
export async function initRedis(): Promise<void> {
  // Build/deploy builders import route modules while collecting page data.
  // Runtime Redis hydration/migrations are not needed for static analysis and
  // can exceed hosted builder deadlines (kilo.ai). Provide an empty, connected
  // in-memory client for build-time reads and defer real migrations to runtime.
  if (isNextBuildPhase()) {
    if (!redisInstance) {
      globalForRedis.__redis_backend = "inline-local"
      redisInstance = new InlineLocalRedis()
    }
    isConnected = true
    coreInitialized = true
    connectionsInitialized = true
    migrationsRan = true
    globalForRedis.__redis_snapshot_loaded = true
    globalForRedis.__redis_fully_connected = true
    return
  }

  // Next.js dev can re-evaluate this module for a newly compiled route while
  // keeping the InlineLocalRedis data on globalThis. In that case the
  // module-scoped `isConnected` / `migrationsRan` flags reset to false even
  // though another module instance has already completed core init +
  // migrations. Honour the global ready marker only when the persisted schema
  // is at the current migration bundle. This keeps dev hot-reload and long-lived
  // production workers from trusting a stale in-memory readiness flag after a
  // code deploy adds new migrations.
  if (globalForRedis.__redis_fully_connected) {
    isConnected = true
    coreInitialized = true
    connectionsInitialized = true
    migrationsRan = true
    try {
      await ensureCoreRedis()
      const { getLatestMigrationVersion, runMigrations } = await import("@/lib/redis-migrations")
      const latestVersion = getLatestMigrationVersion()
      const currentVersion = Number((await redisInstance!.get("_schema_version").catch(() => "0")) || "0")
      if (!Number.isFinite(currentVersion) || currentVersion < latestVersion) {
        console.log(
          `[v0] [Redis] Global ready marker is stale: schema v${currentVersion || 0} < code v${latestVersion}; running pending migrations`,
        )
        globalForRedis.__redis_fully_connected = false
        migrationsRan = false
        await runMigrations()
        globalForRedis.__redis_fully_connected = true
      }
    } catch (error) {
      isConnected = false
      migrationsRan = false
      globalForRedis.__redis_fully_connected = false
      throw error
    }
    return
  }
  if (isConnected) return

  // Startup volatile cleanup: clear stale locks, transient indexes, and
  // rebuildable pipeline families so the engine starts with a clean baseline.
  await cleanupVolatileRuntimeState({ reason: "initRedis" }).catch(() => null)

  if (globalForRedis.__redis_init_promise) return globalForRedis.__redis_init_promise

  globalForRedis.__redis_init_promise = (async () => {
    await ensureCoreRedis()

    if (!migrationsRan) {
      // runMigrations() calls ensureCoreRedis() internally (NOT initRedis), so
      // there is no re-entrancy with the promise we are currently inside.
      //
      // SAFETY: Wrap migrations with a runtime deadline, but never mark Redis
      // connected if the deadline/error fires. The old path swallowed the error
      // and continued with a partially migrated schema, which is exactly how
      // production ended up with missing progress containers, stalled counts,
      // and zombie running flags after deploy/restart. Build-time imports are
      // already short-circuited above, so runtime must prefer correctness and
      // retryability over serving on an incomplete schema.
      const { runMigrations, resetMigrationRunState } = await import("@/lib/redis-migrations")
      const MIGRATIONS_DEADLINE_MS = isProductionEnvironment() ? 180_000 : 60_000
      let migrationTimer: ReturnType<typeof setTimeout> | undefined
      // SAFETY: Wrap with a 90-second deadline. Production coverage repair can
      // legitimately scan/seed every connection on cold start; 35s caused false
      // deadline errors even when routes recovered. Keep a deadline for real
      // deadlocks, but allow complete establishment to finish cleanly.
      // (e.g. by calling initRedis() internally, which awaits THIS very
      // promise), the race rejects after 90 s so the server becomes
      // responsive. The underlying migration may still resolve later, but
      // the server is unblocked. The migration runner also has its own
      // per-migration 30-second deadline for individual migrations.
      try {
        await Promise.race([
          runMigrations(),
          new Promise<never>((_, reject) => {
            migrationTimer = setTimeout(
              () => reject(new Error(`runMigrations() exceeded ${MIGRATIONS_DEADLINE_MS}ms global deadline — retrying on next request`)),
              MIGRATIONS_DEADLINE_MS,
            )
          }),
        ])
        migrationsRan = true
      } catch (migErr) {
        console.error("[v0] [Redis] runMigrations deadline/error:", migErr instanceof Error ? migErr.message : migErr)
        resetMigrationRunState()
        migrationsRan = false
        throw migErr
      } finally {
        if (migrationTimer) clearTimeout(migrationTimer)
      }
    }

    connectionsInitialized = true
    isConnected = true
    globalForRedis.__redis_fully_connected = true
  })()

  try {
    await globalForRedis.__redis_init_promise
  } catch (error) {
    // Runtime must never continue on a partially migrated schema. Log, reset
    // retry state, and propagate the failure so the current route/startup path
    // does not serve stale or missing progression containers. The next caller
    // gets a fresh attempt because the shared promise is cleared below.
    console.error("[v0] [Redis] initialization error (will retry on next call):", error)
    migrationsRan = false
    throw error
  } finally {
    // Clear the shared promise unless we fully succeeded, so retries get a
    // fresh run. Once isConnected is true the top-of-function guard short-
    // circuits and the promise is never consulted again.
    if (!isConnected) {
      globalForRedis.__redis_init_promise = undefined
    }
  }
}

// NOTE: these sync getters intentionally do NOT set isConnected/coreInitialized.
// Flipping isConnected here was a latent hazard: if a getter ran before
// initRedis() (e.g. import-time code), initRedis() would early-return and SKIP
// MIGRATIONS and the snapshot load entirely. They now only guarantee a non-null
// client; ensureCoreRedis()/initRedis() own readiness state and snapshot load.
export function getClient(): RedisClientLike {
  if (!redisInstance) {
    redisInstance = createRedisInstance()
  }
  return redisInstance
}

export function getRedisClient(): RedisClientLike {
  if (!redisInstance) {
    redisInstance = createRedisInstance()
  }
  return redisInstance
}

export async function ensureRedisInitialized(): Promise<void> {
  if (!isConnected || !redisInstance) {
    await initRedis()
  }
}

export function isRedisConnected(): boolean {
  // The module-scoped `isConnected` is false in freshly-evaluated Next.js dev
  // route modules that never called initRedis() in their own scope. Fall back
  // to the globalThis flag which is set by the engine's full init path and
  // survives across module re-evaluations.
  return isConnected || !!globalForRedis.__redis_fully_connected
}

// ========== Helpers ==========

function convertToString(value: any): string {
  if (value === true) return "1"
  if (value === false) return "0"
  if (value === null || value === undefined) return ""
  return String(value)
}

function isEnabledFlag(value: unknown): boolean {
  return value === true || value === 1 || value === "1" || value === "true"
}

function flattenForHmset(obj: Record<string, any>): Record<string, string> {
  const result: Record<string, string> = {}
  for (const [key, value] of Object.entries(obj)) {
    if (value !== undefined && value !== null) {
      if (typeof value === "object" && !Array.isArray(value)) {
        result[key] = JSON.stringify(value)
      } else if (Array.isArray(value)) {
        result[key] = JSON.stringify(value)
      } else {
        result[key] = convertToString(value)
      }
    }
  }
  return result
}

function parseHashValue(value: unknown): unknown {
  // Guard against undefined/null
  if (value === undefined || value === null) return null
  
  // CRITICAL: Must be string to use string methods - fixes "value.startsWith is not a function"
  if (typeof value !== "string") {
    // Return non-string values as-is (numbers, booleans, objects already parsed)
    return value
  }
  
  // Now value is guaranteed to be a string
  const strValue: string = value
  
  if (strValue === "") return ""
  
  // Try to parse as JSON first (only for strings that look like JSON)
  if ((strValue.startsWith("{") && strValue.endsWith("}")) || 
      (strValue.startsWith("[") && strValue.endsWith("]"))) {
    try {
      return JSON.parse(strValue)
    } catch {
      return strValue
    }
  }
  
  // Check for boolean-like values
  if (strValue === "1" || strValue === "true") return true
  if (strValue === "0" || strValue === "false") return false
  
  // Check for numeric values
  if (/^-?\d+$/.test(strValue)) return parseInt(strValue, 10)
  if (/^-?\d+\.\d+$/.test(strValue)) return parseFloat(strValue)
  
  return strValue
}

// Fields that are genuinely numeric but whose raw Redis values are "1", "2",
// etc. — strings that `parseHashValue` would coerce to boolean `true` because
// of the "1"→true shorthand.  For these fields we force a Number() parse so
// the UI slider/input always receives an integer, not `true`/`false`.
const NUMERIC_HASH_FIELDS = new Set([
  "symbol_count", "symbolCount",
  "block_max_stack", "blockMaxStack",
  "block_volume_ratio", "blockVolumeRatio",
  "block_pause_count_ratio", "blockPauseCountRatio",
  "max_concurrent_trades", "maxConcurrentTrades",
  "prev_pos_min_count", "prevPosMinCount",
  "prev_pos_window", "prevPosWindow",
  "main_eval_pos_count", "mainEvalPosCount",
  "real_eval_pos_count", "realEvalPosCount",
  "min_step", "minStep",
  "trailing_min_step", "trailingMinStep",
  "leverage_percentage", "leveragePercentage",
  "live_volume_factor", "preset_volume_factor",
  "volume_factor", "volume_factor_live", "volume_factor_preset",
  "volume_step_ratio",
  "axis_prev_max_window", "axisPrevMaxWindow",
  "axis_last_max_window", "axisLastMaxWindow",
  "axis_cont_max_window", "axisContMaxWindow",
  "axis_pause_max_window", "axisPauseMaxWindow",
  "base_profit_factor", "baseProfitFactor",
  "main_profit_factor", "mainProfitFactor",
  "real_profit_factor", "realProfitFactor",
  "live_profit_factor", "liveProfitFactor",
  "max_drawdown_time_main_hours", "maxDrawdownTimeMainHours",
  "max_drawdown_time_real_hours", "maxDrawdownTimeRealHours",
  "max_drawdown_time_live_hours", "maxDrawdownTimeLiveHours",
  "stage_min_pos_count_base", "stageMinPosCountBase",
  "stage_min_pos_count_main", "stageMinPosCountMain",
  "stage_min_pos_count_real", "stageMinPosCountReal",
])

function parseHash(hash: Record<string, string> | null): Record<string, any> | null {
  // Empty hash → null. Real Redis hGetAll returns {} for missing keys (the
  // emulator now matches that), but getSettings' contract is `any | null`
  // and every caller relies on `getSettings(...) || fallback` to detect
  // "no value". A truthy {} here broke those fallbacks (e.g. /api/orders
  // crashed calling .slice on {} instead of the [] default).
  if (!hash || Object.keys(hash).length === 0) return null
  const result: Record<string, any> = {}
  for (const [key, value] of Object.entries(hash)) {
    if (NUMERIC_HASH_FIELDS.has(key) && typeof value === "string" && /^-?\d+(\.\d+)?$/.test(value)) {
      // Force numeric parse — these fields legitimately hold numbers like "1",
      // "2", "0.1" that parseHashValue would wrongly coerce to true/false/0.
      result[key] = value.includes(".") ? parseFloat(value) : parseInt(value, 10)
    } else {
      result[key] = parseHashValue(value)
    }
  }
  return result
}


const SECONDARY_INDEX_KEYS = {
  positions: "idx:positions",
  trades: "idx:trades",
  indications: "idx:indications",
  strategies: "idx:strategies",
} as const

function positionConnectionIndexKey(connectionId: string): string {
  return `idx:positions:connection:${connectionId}`
}

function tradeConnectionIndexKey(connectionId: string): string {
  return `idx:trades:connection:${connectionId}`
}

function getRecordConnectionId(record: Record<string, any> | null | undefined): string {
  return String(record?.connectionId ?? record?.connection_id ?? "").trim()
}

async function readIndexedHashes(client: RedisClientLike, indexKey: string, keyPrefix: string): Promise<any[]> {
  const ids = await client.smembers(indexKey).catch(() => [] as string[])
  if (ids.length === 0) return []

  const hashes = await Promise.all(
    ids.map((id) => client.hgetall(`${keyPrefix}${id}`).catch(() => ({} as Record<string, string>))),
  )

  const records: any[] = []
  const staleIds: string[] = []
  for (let i = 0; i < ids.length; i++) {
    const hash = hashes[i]
    if (!hash || Object.keys(hash).length === 0) {
      staleIds.push(ids[i])
      continue
    }
    const parsed = parseHash(hash)
    if (parsed) records.push(parsed)
  }

  if (staleIds.length > 0) {
    await client.srem(indexKey, ...staleIds).catch(() => 0)
  }

  return records
}

async function updatePositionIndexes(client: RedisClientLike, id: string, position: Record<string, any>): Promise<void> {
  const key = `position:${id}`
  const previous = await client.hgetall(key).catch(() => ({} as Record<string, string>))
  const previousConnectionId = getRecordConnectionId(previous)
  const nextConnectionId = getRecordConnectionId(position)
  await client.sadd(SECONDARY_INDEX_KEYS.positions, id)
  if (previousConnectionId && previousConnectionId !== nextConnectionId) {
    await client.srem(positionConnectionIndexKey(previousConnectionId), id).catch(() => 0)
  }
  if (nextConnectionId) {
    await client.sadd(positionConnectionIndexKey(nextConnectionId), id)
  }
}

async function removePositionIndexes(client: RedisClientLike, id: string): Promise<void> {
  const existing = await client.hgetall(`position:${id}`).catch(() => ({} as Record<string, string>))
  const connectionId = getRecordConnectionId(existing)
  await client.srem(SECONDARY_INDEX_KEYS.positions, id).catch(() => 0)
  if (connectionId) await client.srem(positionConnectionIndexKey(connectionId), id).catch(() => 0)
}

async function updateTradeIndexes(client: RedisClientLike, id: string, trade: Record<string, any>): Promise<void> {
  const key = `trade:${id}`
  const previous = await client.hgetall(key).catch(() => ({} as Record<string, string>))
  const previousConnectionId = getRecordConnectionId(previous)
  const nextConnectionId = getRecordConnectionId(trade)
  await client.sadd(SECONDARY_INDEX_KEYS.trades, id)
  if (previousConnectionId && previousConnectionId !== nextConnectionId) {
    await client.srem(tradeConnectionIndexKey(previousConnectionId), id).catch(() => 0)
  }
  if (nextConnectionId) {
    await client.sadd(tradeConnectionIndexKey(nextConnectionId), id)
  }
}

async function removeTradeIndexes(client: RedisClientLike, id: string): Promise<void> {
  const existing = await client.hgetall(`trade:${id}`).catch(() => ({} as Record<string, string>))
  const connectionId = getRecordConnectionId(existing)
  await client.srem(SECONDARY_INDEX_KEYS.trades, id).catch(() => 0)
  if (connectionId) await client.srem(tradeConnectionIndexKey(connectionId), id).catch(() => 0)
}

export class DatabaseWriteRateLimitError extends Error {
  readonly code = "DATABASE_WRITE_RATE_LIMIT_EXCEEDED"
  readonly operationName: string
  readonly scope: "second" | "minute"
  readonly current: number
  readonly limit: number

  constructor(operationName: string, scope: "second" | "minute", current: number, limit: number) {
    super(`Database write budget exceeded for ${operationName}: ${current}/${limit} per ${scope}`)
    this.name = "DatabaseWriteRateLimitError"
    this.operationName = operationName
    this.scope = scope
    this.current = current
    this.limit = limit
  }
}

type DatabaseWriteBudgetOptions = { optional?: boolean }
type DatabaseWriteBudgetResult = { allowed: boolean; reason?: DatabaseWriteRateLimitError }

const DATABASE_WRITE_LIMIT_LOG_INTERVAL_MS = 60_000

function parseDatabaseLimit(value: unknown): number {
  const parsed = Number(value ?? 0)
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 0
}

function warnDatabaseWriteBudgetExceeded(error: DatabaseWriteRateLimitError, optional: boolean): void {
  const globalBudget = globalThis as unknown as { __db_write_budget_last_warn?: Record<string, number> }
  if (!globalBudget.__db_write_budget_last_warn) globalBudget.__db_write_budget_last_warn = {}
  const logKey = `${error.operationName}:${error.scope}:${optional ? "optional" : "required"}`
  const now = Date.now()
  if (now - (globalBudget.__db_write_budget_last_warn[logKey] || 0) < DATABASE_WRITE_LIMIT_LOG_INTERVAL_MS) return
  globalBudget.__db_write_budget_last_warn[logKey] = now
  console.warn(
    `[v0] [Redis Write Budget] ${optional ? "Skipping optional" : "Blocking required"} write ${error.operationName}: ${error.current}/${error.limit} per ${error.scope}`,
  )
}

async function readDatabaseWriteLimits(client: RedisClientLike): Promise<{ perSecond: number; perMinute: number }> {
  try {
    const systemSettings = parseHash(await client.hgetall("settings:system")) || {}
    return {
      perSecond: parseDatabaseLimit((systemSettings as any).databaseLimitPerSecond),
      perMinute: parseDatabaseLimit((systemSettings as any).databaseLimitPerMinute),
    }
  } catch {
    return { perSecond: 0, perMinute: 0 }
  }
}

function trackDatabaseSecondOperation(limit: number): { current: number; limit: number; exceeded: boolean } {
  const globalTracker = globalThis as unknown as { __db_ops_second_tracker?: { second: number; count: number } }
  const currentSecond = Math.floor(Date.now() / 1000)
  if (!globalTracker.__db_ops_second_tracker || globalTracker.__db_ops_second_tracker.second !== currentSecond) {
    globalTracker.__db_ops_second_tracker = { second: currentSecond, count: 0 }
  }
  globalTracker.__db_ops_second_tracker.count++
  const current = globalTracker.__db_ops_second_tracker.count
  return { current, limit, exceeded: limit > 0 && current > limit }
}

export async function assertDatabaseWriteBudget(
  operationName: string,
  options: DatabaseWriteBudgetOptions = {},
): Promise<DatabaseWriteBudgetResult> {
  const client = getClient()
  const { perSecond, perMinute } = await readDatabaseWriteLimits(client)

  const secondResult = trackDatabaseSecondOperation(perSecond)
  const minuteResult = await client.trackDatabaseOperation(perMinute)
  const exceeded = secondResult.exceeded
    ? new DatabaseWriteRateLimitError(operationName, "second", secondResult.current, secondResult.limit)
    : minuteResult.exceeded
      ? new DatabaseWriteRateLimitError(operationName, "minute", minuteResult.current, minuteResult.limit)
      : null

  if (!exceeded) return { allowed: true }
  warnDatabaseWriteBudgetExceeded(exceeded, !!options.optional)
  if (options.optional) return { allowed: false, reason: exceeded }
  throw exceeded
}

// ========== Connection Operations ==========

export async function getConnection(id: string): Promise<any | null> {
  await initRedis()
  const client = getClient()
  const hash = await client.hgetall(`connection:${id}`)
  return parseHash(hash)
}

// ──────────�������─────────────────────────────────────────────��───────────────────
// PERF: in-memory TTL cache for `getAllConnections`.
// The dashboard polls every ~8s and each active card fans out multiple
// per-connection requests. Without this cache we issue N KEYS + N HGETALL
// ops per poll per component. A short TTL (1.5s) dedupes bursts without
// introducing user-visible staleness (all writes invalidate the cache
// immediately via `invalidateConnectionsCache()`).
// ──────────────────────���─────────────�������──────────────────��───────────────────
const __CONN_CACHE_TTL_MS = 1500
let __connCache: { at: number; value: any[] } | null = null
let __connInflight: Promise<any[]> | null = null

export function invalidateConnectionsCache(): void {
  __connCache = null
  __connInflight = null
}

export async function getAllConnections(): Promise<any[]> {
  const now = Date.now()
  if (__connCache && now - __connCache.at < __CONN_CACHE_TTL_MS) {
    return __connCache.value
  }
  if (__connInflight) return __connInflight

  __connInflight = (async () => {
    try {
      await initRedis()
      const client = getClient()
      const keys = await client.keys("connection:*")

      // Filter out special sibling keys up-front so we don't fan out HGETALLs
      // for them (reduces Redis roundtrips in large deployments).
      const realKeys = keys.filter(
        (k) =>
          !k.includes(":settings:") &&
          !k.includes(":stats:") &&
          !k.includes(":logs:")
      )

      // Parallelize HGETALL across all connection keys. Previously ran
      // sequentially in a for-loop, which scaled linearly with connection count.
      const hashes = await Promise.all(
        realKeys.map(async (key) => {
          try {
            return await client.hgetall(key)
          } catch (err) {
            console.warn(
              `[v0] [redis-db] getAllConnections: hgetall failed for ${key}`,
              err instanceof Error ? err.message : err
            )
            return null
          }
        })
      )

      const connections = hashes
        .filter((h): h is Record<string, any> => !!h && Object.keys(h).length > 0)
        .map(parseHash)
        .filter((conn) => {
          const id = String(conn?.id ?? "").trim()
          const name = String(conn?.name ?? "").trim()
          const exchange = String(conn?.exchange ?? "").trim()

          if (id && name && exchange) return true

          // Not a crash — ghost keys left from an aborted save or a partial
          // migration are silently skipped. Downgraded from warn to debug to
          // avoid polluting server logs on every poll interval.
          console.debug("[v0] [redis-db] getAllConnections: skipping malformed connection hash", {
            id: id || undefined,
            name: name || undefined,
            exchange: exchange || undefined,
          })
          return false
        })

      __connCache = { at: Date.now(), value: connections }
      return connections
    } finally {
      __connInflight = null
    }
  })()

  return __connInflight
}


export interface ConnectionCountDiagnostics {
  connection_hash_count: number
  legacy_connection_set_count: number
}

export async function getConnectionCountDiagnostics(): Promise<ConnectionCountDiagnostics> {
  await initRedis()
  const client = getClient()
  const [connections, legacyCount] = await Promise.all([
    getAllConnections(),
    client.scard("connections").catch((error: unknown) => {
      console.warn(
        "[v0] [redis-db] Failed to count legacy connections set",
        error instanceof Error ? error.message : error,
      )
      return 0
    }),
  ])

  return {
    connection_hash_count: connections.length,
    legacy_connection_set_count: Number(legacyCount) || 0,
  }
}

export async function reconcileLegacyConnectionsSetFromHashes(): Promise<ConnectionCountDiagnostics & { repaired: boolean }> {
  await initRedis()
  const client = getClient()
  const connections = await getAllConnections()
  const ids = connections
    .map((connection) => String(connection?.id ?? "").trim())
    .filter((id): id is string => id.length > 0)

  await client.del("connections")
  if (ids.length > 0) {
    await client.sadd("connections", ...ids)
  }

  return {
    connection_hash_count: connections.length,
    legacy_connection_set_count: ids.length,
    repaired: true,
  }
}

export async function saveConnection(connection: any): Promise<void> {
  await initRedis()
  const client = getClient()
  const id = connection.id || connection.name
  if (!id) {
    throw new Error("Connection must have an id or name")
  }
  
  const data = flattenForHmset({
    ...connection,
    id,
    updated_at: new Date().toISOString(),
  })
  
  await Promise.all([
    client.hset(`connection:${id}`, data),
    client.sadd("connections", id),
    syncMainEnabledConnectionIndex(client, { ...data, id }),
  ])
  invalidateConnectionsCache()
}

export async function deleteConnection(id: string): Promise<void> {
  await initRedis()
  const client = getClient()
  await Promise.all([
    client.del(`connection:${id}`),
    client.srem("connections", id),
    client.srem("connections:main:enabled", id),
  ])
  invalidateConnectionsCache()
}

// ========== Settings Operations ==========

export async function getSettings(key: string): Promise<any | null> {
  await initRedis()
  const client = getClient()
  const hash = await client.hgetall(`settings:${key}`)
  const parsed = parseHash(hash)
  // ARRAY ROUND-TRIP: setSettings(key, someArray) flattens the array into
  // index-keyed hash fields ("0","1","2",...). Without this reconstruction
  // the caller gets back an OBJECT {0:..,1:..} where it stored an array —
  // every `getSettings("orders") || []` site then crashed on .filter/.slice.
  // Detect the all-numeric-keys shape and rebuild the original array.
  if (parsed && typeof parsed === "object") {
    const keys = Object.keys(parsed)
    if (keys.length > 0 && keys.every((k) => /^\d+$/.test(k))) {
      return keys
        .map(Number)
        .sort((a, b) => a - b)
        .map((i) => (parsed as Record<string, any>)[String(i)])
    }
  }
  return parsed
}

export async function setSettings(key: string, value: any): Promise<void> {
  await initRedis()
  const client = getClient()
  const data = flattenForHmset(value)
  await client.hset(`settings:${key}`, data)
}

export async function persistNow(): Promise<boolean> {
  const client = getClient()
  if (typeof (client as any).persistNow === "function") {
    return (client as any).persistNow()
  }
  if (typeof (client as any).saveToDisk === "function") {
    return (client as any).saveToDisk()
  }
  return false
}

export async function getAllSettings(): Promise<Record<string, any>> {
  await initRedis()
  const client = getClient()
  const keys = await client.keys("settings:*")
  if (keys.length === 0) return {}

  // Fan out every hgetall in parallel — sequential awaits compounded
  // latency linearly with the number of settings hashes, which showed
  // up in export and admin-dashboard endpoints.
  const hashes = await Promise.all(
    keys.map((k) => client.hgetall(k).catch(() => null)),
  )
  const settings: Record<string, any> = {}
  for (let i = 0; i < keys.length; i++) {
    const hash = hashes[i]
    if (!hash) continue
    settings[keys[i].replace("settings:", "")] = parseHash(hash)
  }
  return settings
}

// ─────────────────────��─────────────────��─────────────────────────────
// Canonical app-settings helpers
//
// The project historically drifted between two Redis hashes:
//   - "app_settings" — written by /api/settings (GET/POST/PUT) from the UI
//   - "all_settings" — read by several trade-engine modules
// These helpers unify the view so any consumer gets the operator's saved
// settings regardless of which key happens to hold them. The paired
// `setAppSettings` writer mirrors to BOTH keys so legacy readers that
// haven't been migrated yet (and any forks that expect one or the other)
// continue to work.
//
// `getAppSettings()` returns a merged record with `app_settings` winning
// on conflict (it's the canonical UI-facing key). Missing keys silently
// fall back to an empty object so callers can use `?? default` patterns.
// ─��─��──────────────────────────────────────────��──────────────────────

const APP_SETTINGS_KEY_CANONICAL = "app_settings" as const
const APP_SETTINGS_KEY_LEGACY    = "all_settings" as const

let appSettingsCache: { value: Record<string, any>; ts: number; version: number } | null = null
// Hard-refresh deadline — picks up silent Redis writes that happened
// without going through our mirror writer (e.g. an out-of-band SET from
// a migration script or another Vercel region). The version-counter
// check below handles the common case in single-digit milliseconds.
const APP_SETTINGS_HARD_REFRESH_MS = 30_000

export async function getAppSettings(
  options: { bypassCache?: boolean } = {},
): Promise<Record<string, any>> {
  const now = Date.now()
  const liveVersion = getSettingsVersionCachedSync()
  if (
    !options.bypassCache &&
    appSettingsCache &&
    appSettingsCache.version === liveVersion &&
    now - appSettingsCache.ts < APP_SETTINGS_HARD_REFRESH_MS
  ) {
    return appSettingsCache.value
  }
  try {
    const [canonical, legacy] = await Promise.all([
      getSettings(APP_SETTINGS_KEY_CANONICAL),
      getSettings(APP_SETTINGS_KEY_LEGACY),
    ])
    // Legacy provides fallback values — canonical overrides on conflict.
    const merged = { ...(legacy || {}), ...(canonical || {}) }
    appSettingsCache = { value: merged, ts: now, version: liveVersion }
    return merged
  } catch {
    return appSettingsCache?.value ?? {}
  }
}

/**
 * Convenience scalar reader — falls back through:
 *   1. Individual `settings:{field}` hash (legacy orphan-key path)
 *   2. Canonical `app_settings.{field}`
 *   3. Legacy `all_settings.{field}`
 *   4. Caller-supplied default
 */
export async function getAppSetting<T = unknown>(
  field: string,
  fallback: T,
): Promise<T> {
  try {
    // 1. Individual key (some historical code writes these as scalar hashes)
    const individual = await getSettings(field)
    if (individual !== null && individual !== undefined) {
      const maybeScalar =
        typeof individual === "object" && individual && "value" in individual
          ? (individual as any).value
          : individual
      if (maybeScalar !== null && maybeScalar !== undefined) {
        return maybeScalar as T
      }
    }
  } catch {
    /* non-critical */
  }
  const merged = await getAppSettings()
  const value = merged[field]
  if (value === undefined || value === null) return fallback
  return value as T
}

/**
 * Writer that keeps the canonical + legacy hashes in sync. Call this
 * from the settings UI/API instead of `setSettings("app_settings", ...)`
 * so trade-engine consumers that read `all_settings` also pick up the
 * operator's latest values on the next cycle. Also bumps the global
 * `settings_version` counter so long-running processors detect the
 * change without waiting for their local TTL to expire.
 */
export async function setAppSettings(value: Record<string, any>): Promise<void> {
  await Promise.all([
    setSettings(APP_SETTINGS_KEY_CANONICAL, value),
    setSettings(APP_SETTINGS_KEY_LEGACY,    value),
  ])
  // Bump first so the new version number is known before we stamp the
  // cache; otherwise the same-process cache would look "stale" to the
  // next reader and cause an unnecessary Redis re-read.
  const newVersion = await bumpSettingsVersion()
  appSettingsCache = { value, ts: Date.now(), version: newVersion }
}

/** Invalidates the in-process app-settings cache. Callable from any write path. */
export function invalidateAppSettingsCache(): void {
  appSettingsCache = null
}

// ──────────���──��─────────────────────���──────────────���─���────────────���───
// Live-settings version counter
//
// When an operator hits Save in the Settings UI, the server updates the
// canonical + legacy Redis hashes. But the trade engine is a long-running
// process on its own timers (possibly on another serverless instance),
// so it needs a CHEAP signal that "something changed, bust your cache".
//
// Pattern: a monotonic integer counter at key `settings_version`.
//   - Writers call `bumpSettingsVersion()` (INCR) after every save.
//   - Consumers call `getSettingsVersion()` once per cycle (O(1) GET)
//     and compare against their last-seen value. On mismatch they
//     invalidate their cache of parsed settings fields.
//
// The counter read is itself cached in-process for 250 ms so a tight
// inner loop doing many reads doesn't hammer Redis on every call.
// ─────────────────────────────────────────────────────────────────────

const SETTINGS_VERSION_KEY = "settings_version" as const
let _settingsVersionCached: number = 0
let _settingsVersionFetchedAt = 0
let _settingsVersionRefreshing = false
const SETTINGS_VERSION_READ_TTL_MS = 250

/**
 * Synchronous snapshot of the latest settings version. Used by hot-path
 * cycle loops that can't await. Never hits Redis — returns the value
 * maintained by the most recent call to `getSettingsVersion()` (or the
 * background poll). Callers that see a stale value will simply get a
 * belated refresh on the next cycle, which is acceptable because the
 * soft-refresh deadline kicks in anyway.
 */
export function getSettingsVersionCachedSync(): number {
  // Opportunistically fire a background refresh if the snapshot is
  // older than the read TTL so cycle loops that never call the async
  // variant still see updates within ~250 ms + one cycle.
  const now = Date.now()
  if (
    !_settingsVersionRefreshing &&
    now - _settingsVersionFetchedAt > SETTINGS_VERSION_READ_TTL_MS
  ) {
    _settingsVersionRefreshing = true
    ;(async () => {
      try {
        await initRedis()
        const client = getClient()
        const raw = await client.get(SETTINGS_VERSION_KEY)
        const parsed = Number(raw)
        _settingsVersionCached = Number.isFinite(parsed) ? parsed : _settingsVersionCached
        _settingsVersionFetchedAt = Date.now()
      } catch {
        _settingsVersionFetchedAt = Date.now()
      } finally {
        _settingsVersionRefreshing = false
      }
    })()
  }
  return _settingsVersionCached
}

/**
 * Returns the latest settings version. Cheap — cached for 250 ms. Safe
 * to call on every engine cycle. A strictly monotonic-increasing
 * integer; any change means "something changed, refresh your cache".
 */
export async function getSettingsVersion(): Promise<number> {
  const now = Date.now()
  if (now - _settingsVersionFetchedAt < SETTINGS_VERSION_READ_TTL_MS) {
    return _settingsVersionCached
  }
  if (_settingsVersionRefreshing) {
    // Another in-flight refresh is already going to land shortly; skip
    // the duplicate Redis call and return whatever we had.
    return _settingsVersionCached
  }
  _settingsVersionRefreshing = true
  try {
    await initRedis()
    const client = getClient()
    const raw = await client.get(SETTINGS_VERSION_KEY)
    const parsed = Number(raw)
    _settingsVersionCached = Number.isFinite(parsed) ? parsed : 0
    _settingsVersionFetchedAt = now
  } catch {
    // Keep the last-known value on a transient Redis error.
    _settingsVersionFetchedAt = now
  } finally {
    _settingsVersionRefreshing = false
  }
  return _settingsVersionCached
}

/**
 * Bumps the settings version counter. Call this from every write path
 * that mutates settings (including system settings, per-connection
 * settings, etc.) so cache holders know to refresh. Also invalidates
 * the in-process `appSettingsCache` so the next read in this process
 * is guaranteed fresh without waiting for the 2 s TTL.
 */
export async function bumpSettingsVersion(): Promise<number> {
  try {
    await initRedis()
    const client = getClient()
    const next = await client.incr(SETTINGS_VERSION_KEY)
    const parsed = Number(next)
    _settingsVersionCached = Number.isFinite(parsed) ? parsed : _settingsVersionCached + 1
    _settingsVersionFetchedAt = Date.now()
    // Flush the in-process caches immediately so the same process that
    // wrote the value doesn't hand out stale merged data to readers
    // that call `getAppSettings()` within the 2 s TTL window.
    invalidateAppSettingsCache()
    return _settingsVersionCached
  } catch {
    // If Redis is briefly unavailable, at least invalidate the local
    // cache so the same process re-fetches on next read.
    invalidateAppSettingsCache()
    return _settingsVersionCached
  }
}

// ========== Market Data Operations ==========

export async function getMarketData(symbol: string, interval: string): Promise<any | null> {
  // ── Spec §7 migration: 1s is the canonical timeframe ─────────────
  //
  // The market-data loader was migrated to write only the `:1s`
  // envelope, but dozens of legacy callsites still pass `"1m"`
  // (default in older code paths). Rather than churn every caller
  // we transparently fall back to `:1s` whenever the requested
  // interval is absent. The envelope shape is identical so consumers
  // can't tell the difference; only the `timeframe` field reports
  // "1s" instead of "1m", which all known readers ignore.
  await initRedis()
  const client = getClient()
  const primary = await client.get(`market_data:${symbol}:${interval}`)
  let data = primary
  if (!data && interval !== "1s") {
    data = await client.get(`market_data:${symbol}:1s`)
  }
  if (!data) return null
  try {
    return JSON.parse(data)
  } catch {
    return null
  }
}

export async function setMarketData(symbol: string, interval: string, data: any, ttlSeconds?: number): Promise<void> {
  await initRedis()
  const client = getClient()
  const finalTtl = ttlSeconds ?? 300
  await client.set(`market_data:${symbol}:${interval}`, JSON.stringify(data), { EX: finalTtl })
}

// ========== Position Operations ==========

export async function getPosition(id: string): Promise<any | null> {
  await initRedis()
  const client = getClient()
  const hash = await client.hgetall(`position:${id}`)
  return parseHash(hash)
}

export async function getAllPositions(): Promise<any[]> {
  await initRedis()
  const client = getClient()
  return readIndexedHashes(client, SECONDARY_INDEX_KEYS.positions, "position:")
}

export async function savePosition(position: any): Promise<void> {
  await initRedis()
  const client = getClient()
  const id = position.id
  if (!id) {
    throw new Error("Position must have an id")
  }
  await assertDatabaseWriteBudget("savePosition")

  // Special-case live positions (keys prefixed with "live:") — the live
  // pipeline uses JSON-string keys and open/closed indices under
  // `live:position:${id}` and `live:positions:${connectionId}`. The
  // legacy `position:${id}` hash form is preserved for non-live positions.
  if (String(id).startsWith("live:")) {
    const liveKey = `live:position:${id}`
    try {
      // Persist JSON snapshot (7 day TTL)
      await client.set(liveKey, JSON.stringify(position), ({ ex: 7 * 24 * 60 * 60 } as any))
    } catch {
      // Some adapters don't support EX option — fall back to set only
      await client.set(liveKey, JSON.stringify(position))
    }

	    const connId = position.connectionId || position.connection_id || "unknown"
	    if (!connId || connId === "unknown") {
	      return
	    }

	    // Maintain lightweight reverse indexes for exchange/client tracking IDs.
	    // Live reconciliation and operator diagnostics can resolve a venue order
	    // back to the exact system-owned LivePosition without relying only on
	    // symbol+direction matching (which is ambiguous during restarts,
	    // accumulation, or hedge-mode long+short coexistence).
	    try {
	      const exchangeData = position.exchangeData || {}
	      const trackingIds = new Set<string>()
	      for (const candidate of [
	        position.trackingId,
	        position.system_tracking_id,
	        position.connection_tracking_id,
	        position.exchangeTrackingId,
	        position.clientOrderId,
	        exchangeData.trackingId,
	        exchangeData.system_tracking_id,
	        exchangeData.connection_tracking_id,
	        exchangeData.exchangeTrackingId,
	        exchangeData.clientOrderId,
	      ]) {
	        if (candidate != null && String(candidate).length > 0) trackingIds.add(String(candidate))
	      }
	      if (Array.isArray(exchangeData.clientOrderIds)) {
	        for (const entry of exchangeData.clientOrderIds) {
	          const clientOrderId = entry?.clientOrderId ?? entry?.id
	          if (clientOrderId != null && String(clientOrderId).length > 0) trackingIds.add(String(clientOrderId))
	        }
	      }
	      for (const trackingId of trackingIds) {
	        const key = `live:position:tracking:${connId}:${trackingId}`
	        await client.set(key, id).catch(() => null)
	        await client.expire(key, 7 * 24 * 60 * 60).catch(() => 0)
	      }
	    } catch {
	      // best-effort diagnostics/reconciliation index
	    }

	    // Terminal => move from open index -> closed archive idempotently.
	    // ALL terminal statuses must leave the open index — previously only
	    // "closed" was handled, so "rejected"/"cancelled"/"error" positions fell
	    // into the else-branch below which RE-ADDED them to the open index on
	    // every save. That kept dead positions in the sync loop forever
	    // (observed: tracked=16 statuses={"rejected":16} re-synced every tick).
    const TERMINAL_LIVE_STATUSES = new Set(["closed", "rejected", "cancelled", "canceled", "error"])
    if (TERMINAL_LIVE_STATUSES.has(String(position.status))) {
      try {
        // Remove any existing entries from open list
        await client.lrem(`live:positions:${connId}`, 0, id).catch(() => 0)
        // Check if already in closed list to avoid duplicates.
        // IMPORTANT: lpos returns 0 (integer) when found at index 0 — truthy check
        // `!alreadyClosed` treats 0 as falsy and incorrectly re-adds the entry.
        // Use explicit null/undefined check instead.
        const alreadyClosed = await client.lpos(`live:positions:${connId}:closed`, id).catch(() => null)
        if (alreadyClosed === null || alreadyClosed === undefined) {
          // Only add if not already present
          await client.lpush(`live:positions:${connId}:closed`, id).catch(() => 0)
        }
        // Mark moved so closeLivePosition can detect duplicate increments
        await client.set(`live:positions:${connId}:moved:${id}`, String(Date.now())).catch(() => null)
        await client.expire(`live:positions:${connId}:moved:${id}`, 60 * 60).catch(() => 0)
        
        // Perf: Remove setKey/parentSetKey from live_set_keys index when position closes
        // so getOpenLiveSetKeys fast-path (coordinator's getOpenLiveSetKeys) returns only
        // keys for currently-open positions. This prevents stale keys from accumulating.
        if (position.setKey || position.parentSetKey) {
          try {
            const indexKey = `live_set_keys:${connId}`
            if (position.setKey) await client.srem(indexKey, position.setKey).catch(() => 0)
            if (position.parentSetKey) await client.srem(indexKey, position.parentSetKey).catch(() => 0)
          } catch {
            // best-effort index maintenance
          }
        }
      } catch {
        // best-effort
      }
    } else {
      // Ensure id appears once in the open index (dedupe via lrem -> lpush)
      try {
        await client.lrem(`live:positions:${connId}`, 0, id).catch(() => 0)
        await client.lpush(`live:positions:${connId}`, id).catch(() => 0)
        
        // Perf: Add setKey/parentSetKey to live_set_keys index when position opens so
        // coordinator's getOpenLiveSetKeys can retrieve all active set keys via O(1) SMEMBERS
        // instead of fetching all positions and iterating. Index is maintained as open positions
        // are placed/closed, automatically staying in sync with the live index.
        if (position.setKey || position.parentSetKey) {
          try {
            const indexKey = `live_set_keys:${connId}`
            if (position.setKey) await client.sadd(indexKey, position.setKey).catch(() => 0)
            if (position.parentSetKey) await client.sadd(indexKey, position.parentSetKey).catch(() => 0)
            // TTL: index is ephemeral and auto-maintained; 24h TTL allows recovery if a close
            // marker somehow fails to fire. Fallback scans in getLivePositions will repopulate if needed.
            await client.expire(indexKey, 86400).catch(() => 0)
          } catch {
            // best-effort index maintenance; coordinator falls back to scan on empty index
          }
        }
      } catch {
        // best-effort
      }
    }

    return
  }

  // Non-live positions: maintain as a hash (legacy behaviour)
  const data = flattenForHmset({
    ...position,
    updated_at: new Date().toISOString(),
  })

  await updatePositionIndexes(client, id, data)
  await client.hset(`position:${id}`, data)
}

export async function deletePosition(id: string): Promise<void> {
  await initRedis()
  const client = getClient()
  await removePositionIndexes(client, id)
  await client.del(`position:${id}`)
}

// ========== Trade Operations ==========

export async function getTrade(id: string): Promise<any | null> {
  await initRedis()
  const client = getClient()
  const hash = await client.hgetall(`trade:${id}`)
  return parseHash(hash)
}

export async function getAllTrades(): Promise<any[]> {
  await initRedis()
  const client = getClient()
  return readIndexedHashes(client, SECONDARY_INDEX_KEYS.trades, "trade:")
}

export async function saveTrade(trade: any): Promise<void> {
  await initRedis()
  const client = getClient()
  const id = trade.id
  if (!id) {
    throw new Error("Trade must have an id")
  }
  await assertDatabaseWriteBudget("saveTrade")
  
  const data = flattenForHmset({
    ...trade,
    updated_at: new Date().toISOString(),
  })
  
  await updateTradeIndexes(client, id, data)
  await client.hset(`trade:${id}`, data)
}

// ========== Indication Operations ==========

export async function getIndication(id: string): Promise<any | null> {
  await initRedis()
  const client = getClient()
  const hash = await client.hgetall(`indication:${id}`)
  return parseHash(hash)
}

export async function getAllIndications(): Promise<any[]> {
  await initRedis()
  const client = getClient()
  return readIndexedHashes(client, SECONDARY_INDEX_KEYS.indications, "indication:")
}

export async function saveIndication(indication: any): Promise<void> {
  await initRedis()
  const client = getClient()
  const id = indication.id
  if (!id) {
    throw new Error("Indication must have an id")
  }
  const budget = await assertDatabaseWriteBudget("saveIndication", { optional: true })
  if (!budget.allowed) return
  
  const data = flattenForHmset({
    ...indication,
    updated_at: new Date().toISOString(),
  })
  
  const key = `indication:${id}`
  await client.sadd(SECONDARY_INDEX_KEYS.indications, id)
  await client.hset(key, data)
  // Bound retention: prehistoric/realtime can mint hundreds of thousands
  // of these. Without a TTL the in-process Redis snapshot grows
  // unbounded (observed 295k keys / 39MB after a few quickstart runs)
  // and dev memory blows past the 6GB heap. 24h is plenty for any
  // dashboard/debug consumer; the `indications:{connId}:*` lists
  // (lib/indication-evaluator.ts) are the durable view.
  await client.expire(key, 86400).catch(() => 0)
}

// ========== Strategy Operations ==========

export async function getStrategy(id: string): Promise<any | null> {
  await initRedis()
  const client = getClient()
  const hash = await client.hgetall(`strategy:${id}`)
  return parseHash(hash)
}

export async function getAllStrategies(): Promise<any[]> {
  await initRedis()
  const client = getClient()
  return readIndexedHashes(client, SECONDARY_INDEX_KEYS.strategies, "strategy:")
}

export async function saveStrategy(strategy: any): Promise<void> {
  await initRedis()
  const client = getClient()
  const id = strategy.id
  if (!id) {
    throw new Error("Strategy must have an id")
  }
  await assertDatabaseWriteBudget("saveStrategy")
  
  const data = flattenForHmset({
    ...strategy,
    updated_at: new Date().toISOString(),
  })
  
  await client.sadd(SECONDARY_INDEX_KEYS.strategies, id)
  await client.hset(`strategy:${id}`, data)
}

// ========== Connection State Helpers ==========

export function getConnectionStates(connection: any): {
  base_enabled: boolean
  base_inserted: boolean
  main_enabled: boolean
  main_assigned: boolean
  is_active: boolean
} {
  return {
    base_enabled: isEnabledFlag(connection.is_enabled),
    base_inserted: isEnabledFlag(connection.is_inserted),
    main_enabled: isEnabledFlag(connection.is_enabled_dashboard),
    main_assigned:
      isEnabledFlag(connection.is_assigned) ||
      isEnabledFlag(connection.is_active_inserted) ||
      isEnabledFlag(connection.is_dashboard_inserted),
    is_active:
      (isEnabledFlag(connection.is_assigned) ||
        isEnabledFlag(connection.is_active_inserted) ||
        isEnabledFlag(connection.is_dashboard_inserted)) &&
      isEnabledFlag(connection.is_enabled_dashboard),
  }
}

export function isConnectionAssignedToMain(connection: any): boolean {
  return (
    isEnabledFlag(connection.is_assigned) ||
    isEnabledFlag(connection.is_active_inserted) ||
    isEnabledFlag(connection.is_dashboard_inserted)
  )
}

export function isConnectionMainEnabled(connection: any): boolean {
  return isConnectionAssignedToMain(connection) && isEnabledFlag(connection.is_enabled_dashboard)
}

async function syncMainEnabledConnectionIndex(client: RedisClientLike, connection: any): Promise<void> {
  const id = String(connection?.id || "").trim()
  if (!id) return
  if (isConnectionMainEnabled(connection)) {
    await client.sadd("connections:main:enabled", id)
  } else {
    await client.srem("connections:main:enabled", id)
  }
}

export function isConnectionProcessingEnabled(connection: any): boolean {
  return isEnabledFlag(connection.is_enabled_dashboard)
}

export function isConnectionBaseEnabled(connection: any): boolean {
  return isEnabledFlag(connection.is_enabled)
}

export function buildMainConnectionEnableUpdate(connection: any): any {
  return {
    ...connection,
    is_assigned: "1",
    is_enabled_dashboard: "1",
    is_dashboard_inserted: "1",
    is_active_inserted: "1",
    is_active: "1",
    updated_at: new Date().toISOString(),
  }
}

export function buildMainConnectionDisableUpdate(connection: any): any {
  return {
    ...connection,
    is_assigned: "1",
    is_enabled_dashboard: "0",
    is_active: "0",
    updated_at: new Date().toISOString(),
  }
}

export function buildMainConnectionRemoveUpdate(connection: any): any {
  return {
    ...connection,
    is_assigned: "0",
    is_active_inserted: "0",
    is_dashboard_inserted: "0",
    is_enabled_dashboard: "0",
    is_active: "0",
    updated_at: new Date().toISOString(),
  }
}

export function buildBaseConnectionEnableUpdate(connection: any): any {
  return {
    ...connection,
    is_enabled: "1",
    is_inserted: "1",
    updated_at: new Date().toISOString(),
  }
}

// ========== Stats Operations ==========

export async function closeRedis(): Promise<void> {
  isConnected = false
  globalForRedis.__redis_fully_connected = false
}

export function getRedisRequestsPerSecond(): number {
  const data = globalForRedis.__redis_data
  if (!data || !data.requestStats) return 0
  const stats = data.requestStats
  // If still within the current second, return running count; otherwise return last completed second
  const nowSec = Math.floor(Date.now() / 1000)
  if (nowSec === stats.lastSecond) {
    return stats.requestCount
  }
  return stats.operationsPerSecond
}

export function getConnectionState(id: string): { isRunning: boolean } {
  // Simple state check based on global tracking
  const globalEngineState = globalThis as unknown as { __engine_states?: Map<string, boolean> }
  if (!globalEngineState.__engine_states) {
    globalEngineState.__engine_states = new Map()
  }
  return { isRunning: globalEngineState.__engine_states.get(id) ?? false }
}

export function setConnectionRunningState(id: string, isRunning: boolean): void {
  const globalEngineState = globalThis as unknown as { __engine_states?: Map<string, boolean> }
  if (!globalEngineState.__engine_states) {
    globalEngineState.__engine_states = new Map()
  }
  globalEngineState.__engine_states.set(id, isRunning)
}

// ========== Migration State Management ==========

const globalMigrationState = globalThis as unknown as { __migrations_run?: boolean }

/**
 * Check if migrations have run — uses in-memory state. Returns true if we've
 * already cached that migrations ran; false otherwise.
 * The actual durability check (reading Redis) happens during runMigrations,
 * which compares Redis schema_version against code's max. The in-memory state
 * here just avoids re-running migrations multiple times in the same process.
 */
export function haveMigrationsRun(): boolean {
  return globalMigrationState.__migrations_run ?? false
}

export function setMigrationsRun(value: boolean): void {
  globalMigrationState.__migrations_run = value
  // Also write to Redis for durability across process restart
  try {
    const client = getRedisClient()
    if (client && value) {
      // Non-blocking fire-and-forget Redis write
      client.set("_migrations_run", "true").catch(() => {
        // Ignore write failure — we have the in-memory state as fallback
      })
    }
  } catch {
    // Ignore Redis errors — in-memory state is sufficient fallback
  }
}

/**
 * Returns true when running in a production or Vercel preview environment.
 * Used to decide whether to run expensive "complete coverage" repair passes
 * on every cold start (required for correct migration state + non-zero counts).
 */
export function isProductionEnvironment(): boolean {
  if (typeof process === "undefined") return false
  const env = process.env.NODE_ENV
  const vercelEnv = process.env.VERCEL_ENV || process.env.VERCEL
  // Treat "production" and "preview" (Vercel PR previews) as "production mode" for migrations.
  if (env === "production") return true
  if (vercelEnv === "production" || vercelEnv === "preview") return true
  // Fallback for common hosting hints
  if (process.env.CI === "true" || process.env.VERCEL_GIT_COMMIT_SHA) return true
  return false
}

/**
 * Global Unique Site / Project / Page Instance
 * 
 * The COMPLETE SITE (independent of any individual connection) must be one
 * single unique continuous instance.
 * 
 * - Created exactly once (first ever boot or after explicit full reset).
 * - Every page refresh, new tab, independent open, cron, etc. reuses the
 *   exact same site_session_id.
 * - Prevents "starting new Overall Progression / Instances" on every visit.
 * - "Just Unique" for the whole project.
 */
const GLOBAL_SITE_INSTANCE_KEY = "site:unique_instance"

export async function ensureUniqueSiteInstance(): Promise<{ siteSessionId: string; isNew: boolean }> {
  // This helper is called from production migration coverage while initRedis()
  // is already awaiting runMigrations(). Calling initRedis() again from that
  // path deadlocks on the in-flight global init promise. During an init run the
  // core client is already ready, so use ensureCoreRedis() and proceed; outside
  // init we still run the full init path for normal callers.
  if (globalForRedis.__redis_init_promise && !isConnected) {
    await ensureCoreRedis()
  } else {
    await initRedis()
  }
  const client = getRedisClient()
  if (!client) {
    return { siteSessionId: "fallback-" + Date.now(), isNew: true }
  }

  const existing = await client.hgetall(GLOBAL_SITE_INSTANCE_KEY).catch(() => null)

  if (existing && existing.site_session_id) {
    // Reuse the one and only unique site instance - just touch activity
    await client.hset(GLOBAL_SITE_INSTANCE_KEY, {
      last_activity: new Date().toISOString(),
    }).catch(() => {})

    return { siteSessionId: existing.site_session_id, isNew: false }
  }

  // First time ever (or after full reset) → create the single unique site instance
  const newId = "site_" + Date.now() + "_" + Math.random().toString(36).slice(2, 12)
  const now = new Date().toISOString()

  await client.hset(GLOBAL_SITE_INSTANCE_KEY, {
    site_session_id: newId,
    created_at: now,
    last_activity: now,
    version: "1",
  }).catch(() => {})

  // Mirror into trade_engine:global so all monitoring sees the unique site instance
  await client.hset("trade_engine:global", {
    site_session_id: newId,
    site_instance_created: now,
  }).catch(() => {})

  console.log(`[v0] [SiteInstance] Created the one unique site/project instance: ${newId}`)

  return { siteSessionId: newId, isNew: true }
}

export async function getCurrentSiteInstanceId(): Promise<string | null> {
  await initRedis()
  const client = getRedisClient()
  if (!client) return null
  const data = await client.hgetall(GLOBAL_SITE_INSTANCE_KEY).catch(() => null)
  return data?.site_session_id || null
}

// ========== Engine Connection Operations ==========

export async function getActiveConnectionsForEngine(): Promise<any[]> {
  const client = getRedisClient()
  const indexedIds = await client.smembers("connections:main:enabled").catch(() => [] as string[])
  const connections: any[] = []

  if (indexedIds.length > 0) {
    await Promise.all(indexedIds.map(async (id) => {
      const data = await client.hgetall(`connection:${id}`).catch(() => ({}))
      const connection = { id, ...data }
      if (data && Object.keys(data).length > 0 && isConnectionMainEnabled(connection)) {
        connections.push(connection)
      } else {
        await client.srem("connections:main:enabled", id).catch(() => 0)
      }
    }))
    return connections
  }

  const ids = await client.smembers("connections").catch(() => [] as string[])
  for (const id of ids) {
    const data = await client.hgetall(`connection:${id}`)
    if (data && Object.keys(data).length > 0) {
      const connection = {
        id,
        ...data,
      }
      if (isConnectionMainEnabled(connection)) {
        connections.push(connection)
        await client.sadd("connections:main:enabled", id).catch(() => 0)
      }
    }
  }

  return connections
}

export async function getAllConnectionsWithStatus(): Promise<any[]> {
  const client = getRedisClient()
  const keys = await client.keys("connection:*")
  const connections: any[] = []
  
  for (const key of keys) {
    if (key.includes(":settings") || key.includes(":state")) continue
    const data = await client.hgetall(key)
    if (data && Object.keys(data).length > 0) {
      connections.push({
        id: key.replace("connection:", ""),
        ...data,
      })
    }
  }
  
  return connections
}

// ========== Additional CRUD Operations ==========

export async function createConnection(data: any): Promise<any> {
  await initRedis()
  const client = getRedisClient()
  const id = data.id || `conn_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`

  // Check if connection already exists to prevent duplicates — if it
  // does, update it in place rather than producing a conflicting
  // second row. This is the behaviour the orphan block below was
  // trying to express before it was accidentally left outside the
  // function body (which broke the build with "Return statement is
  // not allowed here" at the module top level).
  const existingConnection = await client.hgetall(`connection:${id}`)
  if (existingConnection && Object.keys(existingConnection).length > 0) {
    console.log(`[v0] [Redis] Connection already exists with id ${id}, updating instead of creating duplicate`)
    const merged = {
      ...data,
      id,
      updated_at: new Date().toISOString(),
    }
    await Promise.all([
      client.hset(`connection:${id}`, merged),
      client.sadd("connections", id),
      syncMainEnabledConnectionIndex(client, merged),
    ])
    invalidateConnectionsCache()
    return merged
  }

  const connectionData = {
    ...data,
    id,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  }
  await Promise.all([
    client.hset(`connection:${id}`, connectionData),
    client.sadd("connections", id),
    syncMainEnabledConnectionIndex(client, connectionData),
  ])
  invalidateConnectionsCache()
  return connectionData
}

export async function updateConnection(id: string, updates: any): Promise<any> {
  const client = getRedisClient()
  const existing = await client.hgetall(`connection:${id}`)
  if (!existing || Object.keys(existing).length === 0) {
    return null
  }
  const updated = {
    ...existing,
    ...updates,
    updated_at: new Date().toISOString(),
  }
  await Promise.all([
    client.hset(`connection:${id}`, updated),
    syncMainEnabledConnectionIndex(client, updated),
  ])
  invalidateConnectionsCache()
  return updated
}

export async function createPosition(data: any): Promise<any> {
  const client = getRedisClient()
  const id = data.id || `pos_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`
  const positionData = {
    ...data,
    id,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  }
  // ── Memory safety: expire positions after 30 days ──────────────────
  // Without TTL, positions accumulate indefinitely, consuming RAM.
  // 30 days is a reasonable retention window for trade history.
  const POSITION_TTL_SEC = 30 * 24 * 60 * 60
  await Promise.all([
    updatePositionIndexes(client, id, positionData),
    client.hset(`position:${id}`, positionData),
    client.expire(`position:${id}`, POSITION_TTL_SEC),
    client.sadd("positions:all", id),
  ])
  return positionData
}

export async function getIndications(connectionId?: string, symbol?: string): Promise<any[]> {
  const client = getRedisClient()
  const indications: any[] = []
  
  try {
    // Indications are stored as Redis lists at: indications:{connectionId}:{symbol}
    // If symbol is provided, fetch directly from that list
    if (connectionId && symbol) {
      const listKey = `indications:${connectionId}:${symbol}`
      const listData = await client.lrange(listKey, 0, 499) // Get last 500
      if (listData && listData.length > 0) {
        for (const item of listData) {
          try {
            const parsed = typeof item === "string" ? JSON.parse(item) : item
            indications.push(parsed)
          } catch (e) {
            // Skip malformed entries
          }
        }
        return indications
      }
    }
    
    // If no symbol specified, collect from all symbol lists for this connection
    if (connectionId) {
      const pattern = `indications:${connectionId}:*`
      const keys = await client.keys(pattern)
      
      for (const key of keys) {
        // Only process keys that are symbol-specific lists: indications:{connectionId}:{symbol}
        // Skip auxiliary keys: indications:{connectionId}:{symbol}:type, :latest, etc.
        // Pattern: key should end after symbol, no more colons
        const keyPattern = /^indications:[^:]+:[^:]+$/
        const isSymbolKey = keyPattern.test(key) && !key.includes(":type:") && !key.includes(":latest:")
        
        if (isSymbolKey) {
          // This is a symbol-specific list, fetch with LRANGE
          const listData = await client.lrange(key, 0, 499)
          if (listData && listData.length > 0) {
            for (const item of listData) {
              try {
                const parsed = typeof item === "string" ? JSON.parse(item) : item
                indications.push(parsed)
              } catch (e) {
                // Skip malformed entries
              }
            }
          }
        }
      }
      
      if (indications.length > 0) {
        return indications
      }
    }
    
    // Final fallback: no indications found
    return []
  } catch (e) {
    console.warn(`[v0] Error reading indications for ${connectionId}/${symbol}:`, e)
    return []
  }
}

/**
 * Store indications for a connection - HIGH FREQUENCY OPTIMIZED
 * Maintains independent sets per configuration type for optimal performance
 */
export async function storeIndications(connectionId: string, symbol: string, indications: any[]): Promise<void> {
  if (!indications || indications.length === 0) return
  
  const client = getRedisClient()
  const mainKey = `indications:${connectionId}`
  
  try {
    // Stamp new indications with metadata.
    const ts = new Date().toISOString()
    const newIndications = indications.map(ind => ({
      ...ind,
      symbol,
      connectionId,
      timestamp: ts,
      configSet: getConfigurationSet(ind.type, ind.value),
    }))

    // ── Main key: read → append → trim → write ───────────────────────────
    const existingRaw = await client.get(mainKey)
    let existing: any[] = []
    if (existingRaw) {
      try {
        existing = JSON.parse(typeof existingRaw === "string" ? existingRaw : JSON.stringify(existingRaw))
        if (!Array.isArray(existing)) existing = []
      } catch { existing = [] }
    }
    existing.push(...newIndications)
    // Keep latest 2500 (250 per symbol × 10 symbols typical)
    if (existing.length > 2500) existing = existing.slice(-2500)

    // ── Per-type keys: group by type in ONE O(N) pass, NOT O(N²) ─────────
    // The previous implementation called `indications.filter(i => i.type === ind.type)`
    // inside a `for (const ind of indications)` loop — O(N²). For a batch of N
    // indications that happens P times per second this is N × P string comparisons/s.
    // Group once into a Map<type, indication[]> so each type key is written once.
    const byType = new Map<string, any[]>()
    for (const ind of newIndications) {
      const t = ind.type as string
      let bucket = byType.get(t)
      if (!bucket) { bucket = []; byType.set(t, bucket) }
      bucket.push(ind)
    }

    // Fan out all writes in parallel — single await instead of sequential loop.
    await Promise.all([
      client.set(mainKey, JSON.stringify(existing), { EX: 3600 } as any),
      ...Array.from(byType.entries()).map(([type, typeInds]) =>
        client.set(`indications:${connectionId}:${type}`, JSON.stringify(typeInds), { EX: 3600 } as any)
      ),
    ])
  } catch (error) {
    console.error(`[v0] Error storing indications for ${connectionId}:`, error)
  }
}

/**
 * Determine configuration set based on indication parameters
 * Used for organizing independent sets per configuration combination
 */
function getConfigurationSet(type: string, value: any): string {
  // Map indication characteristics to configuration sets for independent tracking
  // This allows parallel processing of different configuration combinations
  if (!value || typeof value !== "object") return "config:default"
  
  const stepCount = value.stepCount || 10
  const drawdown = value.drawdownRatio || 0.2
  const activity = value.activityRatio || 0.05
  const rangeRatio = value.rangeRatio || 0.2
  
  // Create configuration hash to group similar configs together
  const configHash = Math.abs(
    ((stepCount * 7) ^ (Math.round(drawdown * 100) * 11) ^ 
     (Math.round(activity * 1000) * 13) ^ (Math.round(rangeRatio * 100) * 17)) % 1000
  )
  
  return `config:${type}:${configHash}`
}

export async function verifyRedisHealth(): Promise<{ healthy: boolean; latency: number; error?: string }> {
  const start = Date.now()
  try {
    const client = getRedisClient()
    // Simple ping test
    await client.set("health:check", Date.now().toString())
    const result = await client.get("health:check")
    const latency = Date.now() - start
    return {
      healthy: result !== null,
      latency,
    }
  } catch (error) {
    return {
      healthy: false,
      latency: Date.now() - start,
      error: error instanceof Error ? error.message : String(error),
    }
  }
}

// ========== Connection Position and Trade Operations ==========

export async function getConnectionPositions(connectionId: string): Promise<any[]> {
  const client = getRedisClient()
  return readIndexedHashes(client, positionConnectionIndexKey(connectionId), "position:")
}

export async function getConnectionTrades(connectionId: string): Promise<any[]> {
  const client = getRedisClient()
  return readIndexedHashes(client, tradeConnectionIndexKey(connectionId), "trade:")
}

export async function getProgressionLogs(connectionId: string, limit: number = 50): Promise<any[]> {
  const client = getRedisClient()
  // Get logs from sorted set or list
  const logsKey = `progression:${connectionId}:logs`
  const logsList = await client.lrange(logsKey, 0, limit - 1)
  
  const logs: any[] = []
  for (const logStr of logsList) {
    try {
      const log = typeof logStr === "string" ? JSON.parse(logStr) : logStr
      logs.push(log)
    } catch {
      logs.push({ message: logStr, timestamp: new Date().toISOString() })
    }
  }
  
  return logs
}

export async function logProgressionEvent(
  connectionId: string,
  phase: string,
  level: "info" | "warning" | "error",
  message: string,
  metadata?: Record<string, any>
): Promise<void> {
  const client = getRedisClient()
  const budget = await assertDatabaseWriteBudget("logProgressionEvent", { optional: true })
  if (!budget.allowed) return
  const logsKey = `progression:${connectionId}:logs`
  
  const logEntry = JSON.stringify({
    timestamp: new Date().toISOString(),
    phase,
    level,
    message,
    ...metadata,
  })
  
  // Add to list (prepend for newest first)
  await client.lpush(logsKey, logEntry)
  // Keep only last 100 logs
  await client.ltrim(logsKey, 0, 99)
  // Set TTL of 7 days
  await client.expire(logsKey, 7 * 24 * 60 * 60)
}

// ========== Connection Filter Functions ==========

export async function getEnabledConnections(): Promise<any[]> {
  const allConnections = await getAllConnections()
  return allConnections.filter(conn => isEnabledFlag(conn.is_enabled) || isEnabledFlag(conn.enabled))
}

export async function getAssignedAndEnabledConnections(): Promise<any[]> {
  return getActiveConnectionsForEngine()
}

export async function getConnectionsByExchange(exchange: string): Promise<any[]> {
  const allConnections = await getAllConnections()
  return allConnections.filter(conn => 
    conn.exchange?.toLowerCase() === exchange.toLowerCase() ||
    conn.exchange_name?.toLowerCase() === exchange.toLowerCase()
  )
}

// ========== Missing Exports for db.ts compatibility ==========

export async function deleteSettings(key: string): Promise<void> {
  const client = getRedisClient()
  await client.del(`settings:${key}`)
}

export async function flushAll(): Promise<void> {
  const client = getRedisClient()
  await client.flushDb()
}

// Cache getRedisStats for 5 s. The key count comes from `client.dbSize()`
// rather than `client.keys("*")`, so this health/stat path avoids
// materializing the full key list while still protecting polling dashboards
// from repeatedly hitting Redis.
let _redisStatsCache: {
  value: { connected: boolean; memoryUsage: number; keyCount: number; uptime: number }
  ts: number
} | null = null
const REDIS_STATS_CACHE_TTL_MS = 5000

export async function getRedisStats(): Promise<{
  connected: boolean
  memoryUsage: number
  keyCount: number
  uptime: number
}> {
  const now = Date.now()
  if (_redisStatsCache && now - _redisStatsCache.ts < REDIS_STATS_CACHE_TTL_MS) {
    return _redisStatsCache.value
  }
  try {
    const client = getRedisClient()
    const keyCount = await client.dbSize()
    const value = {
      connected: true,
      memoryUsage: 0, // In-memory implementation doesn't track this
      keyCount,
      uptime: Date.now() - (globalThis as any).__redis_start_time || 0,
    }
    _redisStatsCache = { value, ts: now }
    return value
  } catch {
    const value = {
      connected: false,
      memoryUsage: 0,
      keyCount: 0,
      uptime: 0,
    }
    // Cache failures briefly too so a broken Redis doesn't pin the CPU
    // retrying connection on every polling request. Shorter TTL so
    // recovery is still detected quickly.
    _redisStatsCache = { value, ts: now - (REDIS_STATS_CACHE_TTL_MS - 1000) }
    return value
  }
}

export async function saveMarketData(symbol: string, timeframe: string, data: any): Promise<void> {
  const client = getRedisClient()
  const key = `market_data:${symbol}:${timeframe}`
  await client.set(key, JSON.stringify(data))
  // Set 24 hour TTL for market data
  await client.expire(key, 86400)
}

// ===========================================================================
// EXPLICIT PERSISTENCE FUNCTIONS
// ===========================================================================

export async function saveDatabaseSnapshot(): Promise<boolean> {
  const client = getRedisClient()
  await client.saveToDisk()
  return true
}

export async function loadDatabaseSnapshot(): Promise<boolean> {
  const client = getRedisClient()
  await client.loadFromDisk()
  return true
}

export function saveDatabaseSnapshotSync(): boolean {
  const client = getRedisClient()
  client.saveToDiskSync()
  return true
}

/**
 * Verify that a position was created by this system using system_tracking_id.
 * Prevents modifications to manually-entered or foreign orders.
 * @returns true if position has valid sys-* tracking ID, false otherwise
 */
export function isSystemCreatedPosition(position: Record<string, string> | null | undefined): boolean {
  if (!position) return false
  const trackingId = String(position.system_tracking_id || "").trim()
  // System tracking IDs follow format: sys-{connId}-{timestamp}-{random}
  return trackingId.startsWith("sys-") && trackingId.length > 10
}

/**
 * Soft reset: Clear all runtime data while preserving coordination framework
 * 
 * Coordination framework that is PRESERVED:
 * - axis_pos_acc:* (axis position accumulation ledgers)
 * - real_pi_acc:* (real PI accumulation structures)
 * - progression:* (progression metadata)
 * - strategy_count:* (strategy count tracking)
 * - pi_history:* (position history framework - structure kept, data cleared)
 * 
 * Allows new strategy progression runs to start fresh without rebuilding
 * the infrastructure. All runtime strategy data and positions are cleared.
 * 
 * @returns object with cleared key counts per bucket
 */
export async function softResetWithCoordinationPreserved(): Promise<{
  deleted: number
  protected: number
  buckets: Record<string, number>
}> {
  const client = getRedisClient()
  
  // Prefixes to preserve (coordination framework + credentials/settings)
  const PRESERVED = [
    "connection:",
    "connections:tombstoned",
    "settings:",
    "app_settings",
    "all_settings",
    "migration:",
    "_migration",
    "_schema_version",
    "predefinitions:",
    "system:base_connections_seeded",
    "auth:",
    "session:",
    "api_key:",
    "axis_pos_acc:",      // COORDINATION FRAMEWORK
    "real_pi_acc:",       // COORDINATION FRAMEWORK
    "progression:",       // COORDINATION FRAMEWORK
    "strategy_count:",    // COORDINATION FRAMEWORK
  ]
  
  // Get all keys
  const allKeys = await client.keys("*").catch(() => [] as string[])
  
  // Filter to keys to delete
  const keysToDelete = allKeys.filter((k) => {
    if (typeof k !== "string") return false
    // Check if key should be preserved
    for (const prefix of PRESERVED) {
      if (k.startsWith(prefix)) return false
    }
    return true
  })
  
  // Build bucket summary before deletion
  const buckets: Record<string, number> = {}
  for (const k of keysToDelete) {
    const idx = k.indexOf(":")
    const bucket = idx > 0 ? k.slice(0, idx) + ":*" : k
    buckets[bucket] = (buckets[bucket] || 0) + 1
  }
  
  // Delete in chunks
  let deleted = 0
  const CHUNK_SIZE = 500
  for (let i = 0; i < keysToDelete.length; i += CHUNK_SIZE) {
    const chunk = keysToDelete.slice(i, i + CHUNK_SIZE)
    try {
      const n = await client.del(...chunk)
      deleted += typeof n === "number" ? n : chunk.length
    } catch {
      for (const k of chunk) {
        try { await client.del(k); deleted++ } catch { /* skip */ }
      }
    }
  }
  
  // Persist to disk
  try {
    if (typeof (client as any).persistNow === "function") {
      await (client as any).persistNow().catch(() => null)
    } else if (typeof (client as any).saveToDisk === "function") {
      await (client as any).saveToDisk().catch(() => null)
    }
  } catch { /* non-critical */ }
  
  return {
    deleted,
    protected: allKeys.length - keysToDelete.length,
    buckets,
  }
}
