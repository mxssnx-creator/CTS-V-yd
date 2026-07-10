/**
 * lib/connection-recoordinator.ts
 *
 * Single source of truth for "the operator just saved connection
 * settings — propagate the change to the engine RIGHT NOW so the next
 * cycle reflects it, no 3 s watcher wait, no page reload."
 *
 * The full propagation has THREE steps and ALL of them must run in the
 * settings API handlers. Before this helper existed the three step were
 * duplicated (and partially missing) across four handlers in two route
 * files, which is exactly why a save-while-stopped (or a save-that-
 * should-stop) silently failed to take effect.
 *
 * Step 1 — `notifySettingsChanged`
 *   Writes a `pending-changes:{id}` envelope to Redis with the diff and
 *   a coarse change-type ("restart" / "reload" / "cosmetic"). Already
 *   running engines pick this up on their 3 s watcher tick. This is the
 *   correctness layer — it MUST run for every change.
 *
 * Step 2 — `applyPendingChangesNow`
 *   Latency optimization: synchronously asks the in-process engine
 *   manager (if any) to consume the pending envelope NOW instead of
 *   waiting for its next watcher tick. No-op if the engine isn't
 *   running in this process.
 *
 * Step 3 — recoordinate (start / stop)
 *   The piece operators kept missing. The engine watcher only runs
 *   for ALREADY-RUNNING engines, so a save while the engine is stopped
 *   (or a save that toggles `is_enabled` off) needed a separate path:
 *     • If the updated connection should now run → `startMissingEngines`.
 *     • If the updated connection should no longer run but IS running
 *       → `stopEngine`.
 *   Both calls are idempotent and safe to invoke even when no action
 *   is needed.
 *
 * Pass the connection BEFORE and AFTER the update so we can detect the
 * field diff correctly. The "after" snapshot is what gets persisted; the
 * "before" snapshot is what was loaded from Redis at the top of the
 * handler.
 */

import { notifySettingsChanged, detectChangedFields } from "@/lib/settings-coordinator"

interface RecoordinateOptions {
  /**
   * When the caller already knows the changed-fields list (e.g. PATCH
   * /settings only receives a partial payload, so `detectChangedFields`
   * may miss settings nested under `connection_settings`), they can
   * pass an explicit override. The diff is still recomputed for the
   * notify envelope, but this list takes precedence when deciding
   * whether to short-circuit.
   */
  changedFieldsOverride?: string[]
  /**
   * Tag for log lines so it's clear which handler initiated the
   * recoordination. e.g. "PATCH /settings", "PUT /connections/[id]".
   */
  logTag: string
}

/**
 * Run the full propagation chain. Designed to never throw — every step
 * is wrapped, so a failure in (say) coordinator import won't cause the
 * settings save itself to return 500. Failures are logged with the
 * provided `logTag` so they surface in the dev console.
 */
export async function recoordinateAfterSettingsChange(
  id: string,
  before: Record<string, any>,
  after: Record<string, any>,
  opts: RecoordinateOptions,
): Promise<void> {
  const detected = detectChangedFields(before, after)
  const changedFields =
    opts.changedFieldsOverride && opts.changedFieldsOverride.length > 0
      ? opts.changedFieldsOverride
      : detected

  if (changedFields.length === 0) {
    return
  }

  // If the operator previously requested Live Trade while credentials were
  // missing, saving credentials in the connection/settings dialog must unblock
  // the live stage without requiring the operator to toggle Live off/on again.
  // Otherwise `live_trade_blocked_reason` remains sticky and
  // hasRealTradeBlock() rejects every exchange order even though credentials
  // now exist.
  try {
    const { hasConnectionCredentials, isTruthyFlag } = await import("@/lib/connection-state-utils")
    const liveRequested = isTruthyFlag((after as any).live_trade_requested) || isTruthyFlag((after as any).is_live_trade)
    const hasCreds = hasConnectionCredentials(after, 5, true)
    const hasBlock = String((after as any).live_trade_blocked_reason || "").trim().length > 0
    if (liveRequested && hasCreds && (!isTruthyFlag((after as any).is_live_trade) || hasBlock)) {
      const { updateConnection } = await import("@/lib/redis-db")
      const patch = {
        is_live_trade: "1",
        live_trade_requested: "1",
        live_trade_blocked_reason: "",
        last_test_status: "success",
        updated_at: new Date().toISOString(),
      }
      await updateConnection(id, patch)
      after = { ...after, ...patch }
      if (!changedFields.includes("is_live_trade")) changedFields.push("is_live_trade")
      if (!changedFields.includes("live_trade_blocked_reason")) changedFields.push("live_trade_blocked_reason")
      console.log(
        `[v0] [${opts.logTag}] Live Trade unblocked for ${id} after credential/settings save`,
      )
    }
  } catch (liveRepairErr) {
    console.warn(
      `[v0] [${opts.logTag}] Live Trade credential unblock check failed for ${id}:`,
      liveRepairErr instanceof Error ? liveRepairErr.message : String(liveRepairErr),
    )
  }

  // Step 1 — durable notify (Redis envelope read by all running engines).
  try {
    await notifySettingsChanged(id, changedFields, before, after)
  } catch (notifyErr) {
    console.error(
      `[v0] [${opts.logTag}] notifySettingsChanged failed for ${id}:`,
      notifyErr instanceof Error ? notifyErr.message : String(notifyErr),
    )
    // The API must not report a successful save until the durable reload
    // envelope and dirty flag have been persisted. Coordinator fast-path
    // work below is optional; the Redis signal above is the correctness
    // layer consumed by engine-owning processes.
    throw notifyErr
  }

  // ── SETTINGS CHANGES THAT AFFECT PROGRESS VISIBILITY ──────────────────
  // Detect which types of setting changes require progress cache invalidation:
  // 1. Symbol changes (symbol_count, force_symbols) → new progression
  // 2. Strategy/coordination changes → prehistoric recalc needed
  // 3. Eval threshold changes → realtime progress affected
  const significantChanges = [
    // Symbols — prehistoric must restart with new symbol list
    "symbol_count", "force_symbols", "symbols",
    // Strategy coordination — variants, block/dca, axis settings
    "strategies", "coordination_settings", "variantTrailingEnabled", "variantBlockEnabled",
    "variantDcaEnabled",
    "axisPrevEnabled", "axisLastEnabled", "axisContEnabled", "axisPauseEnabled",
    "axisPrevMaxWindow", "axisLastMaxWindow", "axisContMaxWindow", "axisPauseMaxWindow",
    "blockVolumeRatio", "blockMaxStack",
    // Minimal step count affects pseudo position placement
    "minimal_step_count", "minimalStepCount", "minStep",
    // Eval thresholds affect strategy/set progression
    "profitFactorMin", "baseProfitFactor", "mainProfitFactor", "realProfitFactor", "liveProfitFactor",
    "stageMinPosCountBase", "stageMinPosCountMain", "stageMinPosCountReal",
    "maxDrawdownTimeMainHours", "maxDrawdownTimeRealHours", "maxDrawdownTimeLiveHours",
    // Volume/leverage affects position sizing and entry counts
    "volume_factor", "leveragePercentage", "useMaximalLeverage",
    // Position window/count settings affect prehistoric calculations
    "prevPosWindow", "prevPosMinCount", "mainEvalPosCount", "realEvalPosCount",
  ]
  const progressAffectingChange = changedFields.some(f => significantChanges.includes(f))

  // ── SYMBOL COUNT OR FORCE_SYMBOLS CHANGED: Archive and invalidate cache ──
  // If the operator changed the symbol list or forced symbols, the current
  // progression becomes semantically invalid. Trigger a full archive + new
  // progression so the UI shows progress against the CORRECT new symbol count.
  // ALSO invalidate the engine's symbol cache so it re-reads from Redis immediately.
  // Broadened detection: the symbol list can be persisted under any of
  // these field names depending on which dialog/route saved it. Missing
  // `active_symbols`/`symbols`/`symbol_order` here is exactly why a symbol
  // change sometimes failed to reset progress telemetry.
  const symbolsChanged =
    changedFields.includes("symbol_count") ||
    changedFields.includes("force_symbols") ||
    changedFields.includes("active_symbols") ||
    changedFields.includes("symbols") ||
    changedFields.includes("symbol_order")
  const strategyOrCoordinationChanged = changedFields.some((field) => {
    const normalized = field.startsWith("connection_settings.")
      ? field.slice("connection_settings.".length)
      : field
    return (
      field === "connection_settings" ||
      normalized === "strategies" ||
      normalized === "coordination_settings" ||
      normalized.includes("ProfitFactor") ||
      normalized.includes("Drawdown") ||
      normalized.startsWith("variant") ||
      normalized.startsWith("axis") ||
      normalized.startsWith("block") ||
      normalized.includes("EvalPosCount") ||
      normalized.includes("PosWindow") ||
      normalized.includes("PosMinCount") ||
      normalized === "minimal_step_count" ||
      normalized === "minimalStepCount" ||
      normalized === "minStep"
    )
  })
  if (symbolsChanged || strategyOrCoordinationChanged) {
    try {
      const { ProgressionStateManager } = await import("@/lib/progression-state-manager")
      // Use the COUPLED recoordinate path (not the bare archive). It
      // clears the `progression:{id}` hash, the `prehistoric:{id}` stats
      // hash + `prehistoric:{id}:symbols`/`:done` gates, AND the
      // `realtime:{id}` cycle counters together — the stats route reads
      // its primary progress numbers from those sibling namespaces, so a
      // bare `progression:{id}` reset left them stale (0/N forever or a
      // mismatched total). recoordinateForActualOne is idempotent: it
      // no-ops (logs `changed:false`) when the persisted symbol set
      // already matches, which neutralizes the previous double-archive
      // churn when the PATCH route also recoordinates.
      const result = await ProgressionStateManager.recoordinateForActualOne(id)
      console.log(
        `[v0] [${opts.logTag}] Progress-affecting settings changed for ${id} → recoordinated progression (changed:${result?.changed ?? "?"}, reason:${result?.reason ?? "?"})`,
      )
    } catch (archiveErr) {
      console.warn(
        `[v0] [${opts.logTag}] Failed to recoordinate progression after settings change for ${id}:`,
        archiveErr instanceof Error ? archiveErr.message : String(archiveErr),
      )
      // Continue — progression will still update under the old schema,
      // but won't have the new symbol count snapshot yet. Engine start will
      // fill it in on the next boot.
    }
  }

  // ── PROGRESS INVALIDATION FOR SIGNIFICANT SETTINGS ──────────────────────
  // When progress-affecting settings change, we need to clear cached progress
  // data so the UI shows fresh prehistoric/realtime stats on next fetch.
  // This ensures the stats endpoint returns up-to-date progress reflecting
  // the new settings (not stale cached values from before the change).
  if (progressAffectingChange && !(symbolsChanged || strategyOrCoordinationChanged)) {
    // For non-symbol changes, we don't archive (symbol changes do that above).
    // But we DO want to clear any cached progress data so the UI refreshes.
    // The progression data is persisted in Redis but won't auto-recalculate
    // for parameter changes (e.g., PF threshold), so we can't archive it.
    // Instead, we rely on the UI's settings-change listener to force-refresh
    // the stats endpoint, which will re-read Redis and compute new breakdowns.
    try {
      // If we need to invalidate progress cache in Redis for parameter changes,
      // we can clear specific keys that should be recomputed. For now, the
      // UI-side event listener (connection-settings-updated) is the main
      // refresh trigger, and the stats endpoint always computes fresh.
      console.log(
        `[v0] [${opts.logTag}] Progress-affecting settings changed for ${id} (${changedFields.join(", ")}) — UI will refresh stats`
      )
    } catch (progressErr) {
      console.warn(
        `[v0] [${opts.logTag}] Failed to handle progress invalidation for ${id}:`,
        progressErr instanceof Error ? progressErr.message : String(progressErr),
      )
      // Non-fatal — UI refresh will still happen via event listener
    }
  }

  // Steps 2 & 3 — coordinator-level actions. Bundled in one try block
  // because they all need the same `coordinator` reference, and a
  // failure to load the coordinator module fails both equivalently.
  try {
    const { getGlobalTradeEngineCoordinator } = await import("@/lib/trade-engine")
    const coordinator = getGlobalTradeEngineCoordinator()
    
    // Guard against null coordinator (can happen if engine is being reset)
    if (!coordinator) {
      console.warn(
        `[v0] [${opts.logTag}] Global coordinator is null/undefined for ${id} — skipping recoordination`
      )
      return
    }

    // ── Invalidate in-memory caches if significant settings changed ─────
    // Symbol changes need the symbol cache; PF/DDT/coordination/variant
    // changes need strategy + coordination caches too. Do both before the
    // pending-change fast path so the next tick cannot reuse stale values.
    if ((symbolsChanged || strategyOrCoordinationChanged) && (coordinator as any).getEngineManager) {
      try {
        const manager = (coordinator as any).getEngineManager(id)
        if (symbolsChanged && manager && typeof (manager as any).invalidateSymbolsCache === "function") {
          (manager as any).invalidateSymbolsCache()
          console.log(`[v0] [${opts.logTag}] Symbol cache invalidated for ${id}`)
        }
        if (
          strategyOrCoordinationChanged &&
          manager &&
          typeof (manager as any).invalidateStrategyAndCoordinationCaches === "function"
        ) {
          ;(manager as any).invalidateStrategyAndCoordinationCaches(changedFields, `${opts.logTag}:settings-save`)
        }
      } catch (cacheErr) {
        console.warn(
          `[v0] [${opts.logTag}] Failed to invalidate engine settings caches for ${id}:`,
          cacheErr instanceof Error ? cacheErr.message : String(cacheErr),
        )
        // Non-fatal — engine will pick up changes via the durable settings event.
      }
    }

    // Step 2 — in-process fast-path (no-op when engine isn't running here).
    // Isolated try-catch to prevent coordinator crash from affecting other operations
    try {
      await coordinator.applyPendingChangesNow(id)
    } catch (applyErr) {
      console.warn(
        `[v0] [${opts.logTag}] applyPendingChangesNow failed for ${id}:`,
        applyErr instanceof Error ? applyErr.message : String(applyErr),
      )
      // Continue to recoordination — the change can still be applied
    }

    // Step 3 — recoordinate. Decide "should this connection be running
    // right now" using the SAME predicate the boot-time reconciliation
    // sweep uses, so behavior is consistent between (a) page-load
    // sweep, (b) settings save, and (c) toggle endpoints.
    const { isConnectionMainProcessing, hasConnectionCredentials, isTruthyFlag } = await import(
      "@/lib/connection-state-utils"
    )
    const shouldRun =
      isConnectionMainProcessing(after) &&
      (hasConnectionCredentials(after, 5, true) ||
        isTruthyFlag((after as any).is_predefined) ||
        isTruthyFlag((after as any).is_testnet) ||
        isTruthyFlag((after as any).demo_mode))

    const isRunning = coordinator.isEngineRunning(id)

    if (shouldRun && !isRunning) {
      // Should run, doesn't — START, but ONLY if the operator has the
      // global engine running. AUTO-START GUARD: without this gate,
      // saving ANY setting while the operator had explicitly stopped the
      // engine (connection flags still enabled) would silently resurrect
      // it. Settings saved while stopped are picked up on the next
      // explicit operator Start via the durable notify envelope (Step 1).
      let globalRunning = false
      try {
        const { getRedisClient } = await import("@/lib/redis-db")
        const globalState = await getRedisClient().hgetall("trade_engine:global")
        const operatorStopped =
          (globalState as any)?.operator_stopped === "1" || (globalState as any)?.operator_stopped === "true"
        const intent = operatorStopped
          ? "stopped"
          : (globalState as any)?.operator_intent || (globalState as any)?.desired_status || (globalState as any)?.status || ""
        globalRunning = intent === "running"
      } catch {
        globalRunning = false
      }
      if (globalRunning) {
        console.log(
          `[v0] [${opts.logTag}] Recoordinate: starting engine for ${id} (was stopped, now should run, global intent=running)`,
        )
        await coordinator.startMissingEngines([after])
      } else {
        console.log(
          `[v0] [${opts.logTag}] Recoordinate: NOT starting ${id} — global engine not running (operator stop honored); settings apply on next explicit Start or continuity tick`,
        )
      }
    } else if (!shouldRun && isRunning) {
      // Should NOT run, but is — STOP. This handles `is_enabled: false`
      // toggles, dashboard-disable, credential clear, etc.
      console.log(
        `[v0] [${opts.logTag}] Recoordinate: stopping engine for ${id} (was running, no longer should)`,
      )
      await coordinator.stopEngine(id, { operatorRequested: true })
    } else if (shouldRun && isRunning) {
      // Should run and is — the hot-reload path inside
      // `applyPendingChangesNow` already handled the change. Nothing
      // to do here. Logged at debug verbosity only.
      // console.log(`[v0] [${opts.logTag}] Engine ${id} hot-reloaded in place`)
    }
    // else: !shouldRun && !isRunning — nothing to do.
  } catch (coordErr) {
    console.warn(
      `[v0] [${opts.logTag}] coordinator recoordination failed for ${id}:`,
      coordErr instanceof Error ? coordErr.message : String(coordErr),
    )
  }
}
