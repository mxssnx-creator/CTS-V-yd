/**
 * Centralised engine + cron + progression timing knobs.
 *
 * Every interval / throttle / hold-time / flush-interval previously
 * scattered as `private static readonly` constants across realtime-processor,
 * strategy-processor, live-stage, engine-progression-logs, and the
 * sync-live-positions cron is now read from a single Redis-backed hash
 * `settings:system` (mirrored to legacy `settings:system_settings` by
 * /api/settings/system — see that route's `writeMirroredSystem`).
 *
 * ── Why a sync getter on top of an async refresher ─────────────────────
 * Tick sites (realtime processor hot loop, strategy flow gate) run
 * dozens of times per second per connection. Hitting Redis on every
 * gate evaluation would defeat the very throttles being read. So:
 *   - `refreshEngineTimings()` is async, throttled to one Redis hit
 *     every CACHE_TTL_MS, called opportunistically from non-hot paths
 *     and once on module init (fire-and-forget).
 *   - `getEngineTimings()` is sync, returns the last cached snapshot
 *     (or hard-coded DEFAULTS until the first refresh lands).
 *
 * On settings change, /api/settings/system bumps the settings-version
 * counter. Any caller that wants immediate take-effect can call
 * `refreshEngineTimings({ force: true })`.
 */

import { initRedis, getRedisClient } from "@/lib/redis-db"

export interface EngineTimings {
  // ── Cron self-loop cadence ────────────────────────────────────────────
  // Vercel cron schedule minimum is 1 minute (`* * * * *`). To get sub-
  // minute cadence the cron handler runs N iterations within one 60 s
  // invocation, sleeping `cronSyncIntervalSeconds` between each. Effective
  // sync cadence = `cronSyncIntervalSeconds`. Range: 5–60 s.
  cronSyncIntervalSeconds: number

  // ── Realtime-processor close path throttle ────────────────────────────
  // `RealtimeProcessor.maybeRunLiveSync()` is gated by this. Lower =
  // faster close-on-SL/TP detection but more REST calls to the exchange.
  // Default 200 ms — matches the live exchange-positions update cadence
  // so SL/TP cross detection and protection-order healing run in lock-
  // step with the freshest price data the venue gives us.
  liveSyncIntervalMs: number

  // ── Post-completion breath for live sync ──────────────────────────────
  // Elapsed AFTER the previous sync cycle fully finishes (all per-position
  // branches, protection-order placements / cancels, Redis writes done)
  // and BEFORE the next cycle is permitted to start.
  //
  // This is a POST-COMPLETION pause, not a start-to-start interval.
  // The timing model is:
  //   [cycle starts] → ... work ... → [cycle ends] → liveSyncPauseMs wait
  //   → [next cycle may start, subject to liveSyncIntervalMs gate]
  //
  // Purpose: anti-hang / event-loop protection. A slow exchange response
  // followed immediately by another dispatch would stack callbacks and
  // starve other JS microtasks. The pause gives the runtime a guaranteed
  // breath between back-to-back exchange calls. Range 10–200 ms, default 50 ms.
  liveSyncPauseMs: number

  // ── Realtime tick heartbeat throttle ──────────────────────────────────
  // How often the engine-state heartbeat (Redis `trade_engine_state:*`)
  // is rewritten. Independent of liveSync. 1000 ms = once per second.
  heartbeatIntervalMs: number

  // ── Strategy flow throttling ──────────────────────────────────────────
  // See lib/trade-engine/strategy-processor.ts header for the gate
  // matrix. Hard throttle is the absolute minimum gap between two
  // strategy-flow runs for the same (connection, symbol).
  strategyFlowMinIntervalMs: number
  strategyFlowHardThrottleMs: number
  strategyFlowMaxIntervalMs: number

  // ── Progression-lock TTL extension cadence ────────────────────────────
  // Engine extends its per-connection progression lock every N ms to
  // prevent a leadership-flap on transient Redis latency. Used by both
  // engine-manager (extender setInterval) and progression-lock module.
  lockExtendIntervalMs: number

  // ── Max position hold time (force-close after) ────────────────────────
  // Live-stage closes any position held longer than this with reason
  // `max_hold_time_exceeded`. Default 4h. `0` disables the check.
  maxPositionHoldMs: number

  // ── Progression log buffer flush cadence ──────────────────────────────
  // `lib/engine-progression-logs.ts` buffers progression events and
  // flushes either when the buffer hits 50 entries or this interval
  // elapses. NOTE: this is read at module init; runtime changes apply
  // after engine restart (the setInterval handle is fixed at first read).
  progressionBufferFlushMs: number

  // ── Three independent progression loops (the engine's "heartbeat") ──
  // The engine drives three top-level loops, each independent of the others:
  //
  //   A. Prehistoric Progression
  //   B. Realtime  Progression
  //   C. LivePositions Progression (live-exchange sync)
  //
  // For every loop the timing model is:
  //
  //   [previous cycle ends] ──► *CyclePauseMs wait (anti-hang breath)
  //                          ──► [new cycle may start if interval elapsed]
  //
  // *IntervalMs  = minimum start-to-start gap (schedule / cadence).
  //               New cycle is skipped when now - lastStart < intervalMs.
  //
  // *CyclePauseMs = minimum post-COMPLETION gap (anti-hang protection).
  //               After the previous cycle fully finishes, the loop waits
  //               this long before triggering the next one — regardless of
  //               how long the cycle itself took. This prevents tight
  //               back-to-back dispatches from starving the event loop when
  //               exchange calls are slow, and gives Redis writes time to
  //               flush before the next read. Default 50 ms for A/B.
  //               These are NOT cadence / interval timings.
  prehistoricIntervalMs: number    // Loop A: start-to-start cadence
  prehistoricCyclePauseMs: number  // Loop A: post-completion breath (anti-hang)
  realtimeIntervalMs: number       // Loop B: start-to-start cadence
  realtimeCyclePauseMs: number     // Loop B: post-completion breath (anti-hang)
  livePositionsCyclePauseMs: number // Loop C: post-completion breath (anti-hang)
  //  Loop C interval = liveSyncIntervalMs (exists above, shared with the
  //  maybeRunLiveSync gate — same concept, same 200 ms value).

  // ── Hedge Accumulation / Directional Neutralisation ───────────────────────
  // Per spec: instead of blindly stacking long & short sets into exchange
  // positions, the engine counts per-direction signal volumes during BASE→MAIN
  // and then bounds the net delta that each Real→Live promotion adds. When
  // long and short are both present for the same symbol the net Long + net
  // Short approach parity; excess signals that would push imbalance beyond the
  // configured threshold are suppressed for that cycle.
  //
  // `neutralizeEnabled`  — master on/off (default off for backward compat)
  // `neutralizeThresholdPct`  — imbalance % (|L−S|/(L+S)) above which to reduce
  // `neutralizeMaxPerDirection` — hard cap on concurrent sets before excess is shed
  // `neutralizeVolumeMode` — how to adjust volumes on neutralisation:
  //    "neutralize" – only add volume equal to the net delta
  //    "rebalance"  – add full volume but rebalance towards the short side
  //    "reduce"     – add at reduced scale proportional to net fraction
  neutralizeEnabled: boolean
  neutralizeThresholdPct: number
  neutralizeMaxPerDirection: number
  neutralizeVolumeMode: "neutralize" | "rebalance" | "reduce"

  // ── API & Exchange Operation Timeouts ──────────────────────────────────
  // Configurable timeouts for exchange API calls and operations.
  // Set via Settings > System > API & Exchange Timeouts.
  // All values in milliseconds.
  apiTimeoutMs: number // 5s - 120s, default 40s - general API call timeout
  apiPlaceOrderTimeoutMs: number // 10s - 120s, default 40s - order placement timeout
  apiCancelOrderTimeoutMs: number // 5s - 60s, default 20s - order cancellation timeout
  apiPositionTimeoutMs: number // 5s - 60s, default 20s - position queries timeout

  // ── Position Ceilings ─────────────────────────────────────────────────
  // Max concurrent positions per direction. Enforced by indication processor.
  // Set via Settings > System > Position Ceilings.
  // Read at every cycle, changes apply within cache TTL (~10 s).
  maxPositionsLong: number // Max concurrent long positions (default 1)
  maxPositionsShort: number // Max concurrent short positions (default 1)
}

export const DEFAULT_ENGINE_TIMINGS: EngineTimings = {
  cronSyncIntervalSeconds:   15,
  // Tuned for sub-second close response — was 5_000 ms, lowered to match
  // the live exchange-positions cadence (~200 ms). Combined with the
  // `liveSyncPauseMs` post-cycle breath this gives ~5 close-path sweeps
  // per second while still letting each sweep finish cleanly.
  // Tuned to 120 ms (≈8 sweeps/sec) for fastest safe close/fill detection
  // on short-hold trades. Stays above the 100 ms floor (below that, sweeps
  // outrun the exchange price tick and just burn REST quota). This is the
  // start-to-start cadence for syncWithExchange (Loop C); raising above
  // 1000 ms risks stale position state and double-close.
  liveSyncIntervalMs:        1_000,
  liveSyncPauseMs:             250,
  heartbeatIntervalMs:       1_000,
  strategyFlowMinIntervalMs: 5_000,
  strategyFlowHardThrottleMs: 2_500,
  strategyFlowMaxIntervalMs: 15_000,
  lockExtendIntervalMs:     15_000,
  maxPositionHoldMs:    4 * 60 * 60 * 1000,
  progressionBufferFlushMs:  3_000,
  // ── API/Exchange operation timeout defaults ────────────────────────────
  apiTimeoutMs:            40_000,  // 40s general timeout for BingX API
  apiPlaceOrderTimeoutMs:  40_000,  // 40s for order placement
  apiCancelOrderTimeoutMs: 20_000,  // 20s for order cancellation
  apiPositionTimeoutMs:    20_000,  // 20s for position queries
  // ── Three-progression defaults ────────────────────────────────────────
  // *IntervalMs  = start-to-start cadence (skips new cycle if too soon)
  // *CyclePauseMs = post-COMPLETION breath — anti-hang protection only.
  //   After the previous cycle ends, wait this before the next may begin.
  //   50 ms is deliberately short: just enough to yield the event loop
  //   and let pending microtasks/I-O callbacks drain. Not a pacing timer.
  prehistoricIntervalMs:       1_000,  // Loop A: 1 s cadence
  prehistoricCyclePauseMs:        50,  // Loop A: post-completion breath
  realtimeIntervalMs:          1_000,  // Loop B: 200 ms cadence (faster signal→dispatch)
  realtimeCyclePauseMs:          250,  // Loop B: post-completion breath
  livePositionsCyclePauseMs:     500,  // Loop C: post-completion breath (interval = liveSyncIntervalMs 120 ms)
  // ── Hedge Accumulation defaults (disabled until opted-in) ────────────────
   neutralizeEnabled:               false,
   neutralizeThresholdPct:          10,   // 10 % imbalance before reducing
   neutralizeMaxPerDirection:       200,  // up to 200 concurrent sets before shedding
   neutralizeVolumeMode:            "neutralize", // net-delta-only addition
  // ── Position Ceiling defaults ──────────────────────────────────────────
   maxPositionsLong:                1,    // Default: 1 concurrent long position
   maxPositionsShort:               1,    // Default: 1 concurrent short position
}

// Hard min/max bounds — UI + API normalise to these to avoid pathological
// values (a 1ms tick rate would lock the event loop; a 1h heartbeat
// would silence the dashboard's "engine alive" indicator).
export const ENGINE_TIMING_BOUNDS: Record<keyof EngineTimings, { min: number; max: number }> = {
  cronSyncIntervalSeconds:   { min: 5,           max: 60                  },
  // Lower bound 100 ms — anything faster than the exchange's own price
  // tick is wasted REST calls. Upper bound capped at 1000 ms (1 sweep/sec)
  // — raising above this causes fill/close detection to lag by >1 tick,
  // producing stale position state and double-close races.
  // Default 200 ms = 5 sweeps/sec. Do not raise without explicit intent.
  liveSyncIntervalMs:        { min: 500,         max: 5_000               },
  liveSyncPauseMs:           { min: 100,         max: 1_000                 },
  heartbeatIntervalMs:       { min: 250,         max: 30_000              },
  strategyFlowMinIntervalMs: { min: 250,         max: 60_000              },
  strategyFlowHardThrottleMs:{ min: 100,         max: 30_000              },
  strategyFlowMaxIntervalMs: { min: 1_000,       max: 5 * 60_000          },
  lockExtendIntervalMs:      { min: 1_000,       max: 60_000              },
  maxPositionHoldMs:         { min: 0 /* off */, max: 7 * 24 * 60 * 60_000 },
  progressionBufferFlushMs:  { min: 500,         max: 60_000              },
  // ── API/Exchange operation timeouts ───────────────────────────────────
  apiTimeoutMs:              { min: 5_000,       max: 120_000             },
  apiPlaceOrderTimeoutMs:    { min: 5_000,       max: 120_000             },
  apiCancelOrderTimeoutMs:   { min: 5_000,       max: 60_000              },
  apiPositionTimeoutMs:      { min: 5_000,       max: 60_000              },
  // ── Three-progression bounds ──────────────────────────────────────────
  // Interval floors at 200 ms prevent a runaway 1 ms cadence from locking
  // the event loop. Interval ceilings at 60 s let operators "park" a loop.
  //
  // Pause bounds are intentionally narrow (10–500 ms) because these are
  // anti-hang breaths, not pacing timers. A pause > 500 ms would make the
  // loop feel unresponsive; < 10 ms would give no meaningful yield.
  prehistoricIntervalMs:     { min: 200,         max: 60_000              },
  prehistoricCyclePauseMs:   { min: 10,          max: 500                 },  // breath, not cadence
  realtimeIntervalMs:        { min: 500,         max: 60_000              },
  realtimeCyclePauseMs:      { min: 100,         max: 2_000                 },  // breath, not cadence
  livePositionsCyclePauseMs: { min: 100,         max: 2_000                 },  // breath, not cadence
// ── Hedge Accumulation bounds ─────────────────────────────────────────────
   neutralizeEnabled:           { min: 0,           max: 1  /* boolean */    },
   neutralizeThresholdPct:      { min: 0,           max: 50                  },
   neutralizeMaxPerDirection:   { min: 1,           max: 500                 },
   neutralizeVolumeMode:        { min: 0,           max: 0  /* handled below */ },
  // ── Position Ceiling bounds ───────────────────────────────────────────
   maxPositionsLong:            { min: 1,           max: 50                  },
   maxPositionsShort:           { min: 1,           max: 50                  },
}

// snake_case key in Redis hash → camelCase key in object. Both forms are
// accepted on read so a hand-edited HSET against either casing works.
const REDIS_KEY_MAP: Record<keyof EngineTimings, string[]> = {
  cronSyncIntervalSeconds:    ["cron_sync_interval_seconds",    "cronSyncIntervalSeconds"],
  liveSyncIntervalMs:         ["live_sync_interval_ms",         "liveSyncIntervalMs"],
  liveSyncPauseMs:            ["live_sync_pause_ms",            "liveSyncPauseMs"],
  heartbeatIntervalMs:        ["heartbeat_interval_ms",         "heartbeatIntervalMs"],
  strategyFlowMinIntervalMs:  ["strategy_flow_min_interval_ms", "strategyFlowMinIntervalMs"],
  strategyFlowHardThrottleMs: ["strategy_flow_hard_throttle_ms","strategyFlowHardThrottleMs"],
  strategyFlowMaxIntervalMs:  ["strategy_flow_max_interval_ms", "strategyFlowMaxIntervalMs"],
  lockExtendIntervalMs:       ["lock_extend_interval_ms",       "lockExtendIntervalMs"],
  maxPositionHoldMs:          ["max_position_hold_ms",          "maxPositionHoldMs"],
  progressionBufferFlushMs:   ["progression_buffer_flush_ms",   "progressionBufferFlushMs"],
  apiTimeoutMs:               ["api_timeout_ms",                "apiTimeoutMs"],
  apiPlaceOrderTimeoutMs:     ["api_place_order_timeout_ms",    "apiPlaceOrderTimeoutMs"],
  apiCancelOrderTimeoutMs:    ["api_cancel_order_timeout_ms",   "apiCancelOrderTimeoutMs"],
  apiPositionTimeoutMs:       ["api_position_timeout_ms",       "apiPositionTimeoutMs"],
  prehistoricIntervalMs:      ["prehistoric_interval_ms",       "prehistoricIntervalMs"],
  prehistoricCyclePauseMs:    ["prehistoric_cycle_pause_ms",    "prehistoricCyclePauseMs"],
  realtimeIntervalMs:         ["realtime_interval_ms",          "realtimeIntervalMs"],
  realtimeCyclePauseMs:       ["realtime_cycle_pause_ms",       "realtimeCyclePauseMs"],
  livePositionsCyclePauseMs:  ["live_positions_cycle_pause_ms", "livePositionsCyclePauseMs"],
  neutralizeEnabled:          ["neutralize_enabled",          "neutralizeEnabled"],
  neutralizeThresholdPct:     ["neutralize_threshold_pct",    "neutralizeThresholdPct"],
  neutralizeMaxPerDirection:  ["neutralize_max_per_direction","neutralizeMaxPerDirection"],
  neutralizeVolumeMode:       ["neutralize_volume_mode",      "neutralizeVolumeMode"],
  maxPositionsLong:           ["max_positions_long",          "maxPositionsLong"],
  maxPositionsShort:          ["max_positions_short",         "maxPositionsShort"],
}

const CACHE_TTL_MS = 10_000

let cached: EngineTimings = { ...DEFAULT_ENGINE_TIMINGS }
let cachedAt = 0
let inflight: Promise<EngineTimings> | null = null

function clamp(key: keyof EngineTimings, value: number): number {
  const b = ENGINE_TIMING_BOUNDS[key]
  if (!Number.isFinite(value)) return DEFAULT_ENGINE_TIMINGS[key] as number
  return Math.max(b.min, Math.min(b.max, value))
}

function parseTimingsFromHash(hash: Record<string, any> | null | undefined): EngineTimings {
  const out: EngineTimings = { ...DEFAULT_ENGINE_TIMINGS }
  if (!hash) return out
  ;(Object.keys(REDIS_KEY_MAP) as (keyof EngineTimings)[]).forEach((k) => {
    const aliases = REDIS_KEY_MAP[k]
    let raw: any = undefined
    for (const a of aliases) {
      if (hash[a] !== undefined && hash[a] !== null && hash[a] !== "") {
        raw = hash[a]
        break
      }
    }
    if (raw === undefined) return
    if (k === "neutralizeEnabled") {
      out[k] = raw === "1" || raw === 1 || raw === true
    } else if (k === "neutralizeVolumeMode") {
      out[k] = raw as "neutralize" | "rebalance" | "reduce"
    } else if (k === "neutralizeThresholdPct" || k === "neutralizeMaxPerDirection") {
      const n = parseFloat(String(raw))
      if (Number.isFinite(n)) out[k] = n
    } else {
      out[k] = clamp(k, parseFloat(String(raw)))
    }
  })
  return out
}

/**
 * Async refresher. De-duplicates concurrent calls. Respects CACHE_TTL_MS
 * unless `force: true` is passed (used by /api/settings/system after a
 * write so the next tick sees the new value immediately).
 */
export async function refreshEngineTimings(opts: { force?: boolean } = {}): Promise<EngineTimings> {
  const now = Date.now()
  if (!opts.force && now - cachedAt < CACHE_TTL_MS) return cached
  if (inflight) return inflight
  inflight = (async () => {
    try {
      await initRedis()
      const client = getRedisClient()
      // Merge canonical + legacy hashes (canonical wins). Matches the
      // mirror-write pattern in /api/settings/system.
      const [canonical, legacy] = await Promise.all([
        client.hgetall("settings:system").catch(() => ({})),
        client.hgetall("settings:system_settings").catch(() => ({})),
      ])
      const merged = { ...(legacy || {}), ...(canonical || {}) }
      cached = parseTimingsFromHash(merged)
      cachedAt = Date.now()
      return cached
    } catch {
      // On Redis error keep the previous cache rather than reverting to
      // defaults — protects against transient outages causing throttle
      // resets that could double-fire SL/TP healing.
      return cached
    } finally {
      inflight = null
    }
  })()
  return inflight
}

/**
 * Sync getter for hot loops. Returns the last refreshed snapshot, or
 * DEFAULTS if no refresh has completed yet. Never blocks, never throws.
 *
 * Opportunistically kicks a background refresh when the cache is stale
 * so a long-running process with no async settings-change touch points
 * still gets new values within CACHE_TTL_MS of the next tick after a
 * settings write.
 */
export function getEngineTimings(): EngineTimings {
  if (Date.now() - cachedAt >= CACHE_TTL_MS) {
    // Fire-and-forget; ignore the promise. Next tick will see fresh data.
    refreshEngineTimings().catch(() => {})
  }
  return cached
}

// Kick a refresh on module load so the first tick after process start
// doesn't have to fall back to DEFAULTS.
refreshEngineTimings().catch(() => {})
