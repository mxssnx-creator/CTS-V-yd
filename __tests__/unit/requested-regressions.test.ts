import fs from "fs"
import path from "path"

const repo = path.resolve(__dirname, "../..")
const read = (file: string) => fs.readFileSync(path.join(repo, file), "utf8")

describe("requested regression guardrails", () => {

  test("live order test endpoints require explicit server and request safety gates", () => {
    const safety = read("lib/live-order-safety.ts")
    const placeOrder = read("app/api/testing/place-order/route.ts")
    const liveOrdersTest = read("app/api/test/live-orders-test/route.ts")

    expect(safety).toContain('process.env.ALLOW_LIVE_ORDER_PLACEMENT === "1"')
    expect(safety).toContain('confirmLiveOrderPlacement === true')
    expect(safety).toContain('I understand this places real exchange orders')
    expect(placeOrder).toContain('const willUseRealExchange = !forceSim && !!connection.api_key && !!connection.api_secret')
    expect(placeOrder).toContain('getLiveOrderSafetyFailure(body)')
    expect(placeOrder).toContain('mode: "blocked_live_order_safety"')
    expect(placeOrder).toContain('const orderMode = willUseRealExchange ? "live" : "simulated"')
    expect(placeOrder).toContain('"live_orders_simulated_count"')
    expect(placeOrder).toContain('const direction: "long" | "short" = sideKey === "short" || sideKey === "sell" ? "short" : "long"')
    expect(placeOrder).toContain('const exchangeSide: "buy" | "sell" = direction === "long" ? "buy" : "sell"')
    expect(placeOrder).toContain('`${symbolKey}:${direction}:placed`')
    expect(placeOrder).toContain('`${symbolKey}:${direction}:filled`')
    expect(placeOrder).not.toContain('JSON.stringify(existing)')
    expect(placeOrder).not.toContain("symbol,\n          side,")
    expect(liveOrdersTest).toContain('getLiveOrderSafetyFailure(body)')
    expect(liveOrdersTest).toContain('mode: "blocked_live_order_safety"')
  })

  test("live order statistics keep long and short buckets independent", () => {
    const liveStage = read("lib/trade-engine/stages/live-stage.ts")
    const statsRoute = read("app/api/connections/progression/[id]/stats/route.ts")

    expect(liveStage).toContain('const sideKey = String(side || "").trim().toLowerCase()')
    expect(liveStage).toContain('sideKey.includes("short") || sideKey === "sell"')
    expect(liveStage).toContain('const symbolKey = String(symbol || "").trim().toUpperCase()')
    expect(liveStage).toContain('const field = `${symbolKey}:${dir}:${metric}`')

    expect(statsRoute).toContain("Legacy/testing route compatibility")
    expect(statsRoute).toContain('rawSide.includes("short") || rawSide === "sell"')
    expect(statsRoute).toContain("const legacyCount = n(parsed?.count ?? 0)")
    expect(statsRoute).toContain("parsed?.filled ?? parsed?.ordersFilled ?? legacyCount")
    expect(statsRoute).toContain("entry[direction][kind] += value")
    expect(statsRoute).not.toContain("entry[direction][kind] = value")
  })

  test("progression strategy totals are pipeline-aware and do not sum cascade stages", () => {
    const statsRoute = read("app/api/connections/progression/[id]/stats/route.ts")

    expect(statsRoute).toContain("Pipeline-aware total: Base → Main → Real → Live is a cascade")
    expect(statsRoute).toContain("total: stratTotal")
    expect(statsRoute).not.toContain("total: (stratCounts.base || 0) + (stratCounts.main || 0) + (stratCounts.real || 0) + (stratCounts.live || 0)")
    expect(statsRoute).not.toContain("full pipeline throughput across all stages")
  })


  test("live-trade UI uses requested intent so sliders do not flip off while blocked", () => {
    const engineStates = read("app/api/connections/[id]/engine-states/route.ts")
    const activeCard = read("components/dashboard/active-connection-card.tsx")
    const optionsBar = read("components/dashboard/quickstart-options-bar.tsx")
    const quickstart = read("components/dashboard/quickstart-section.tsx")

    expect(engineStates).toContain("const liveRequested = toBoolean((connection as any).live_trade_requested)")
    expect(engineStates).toContain("const flagLive    = liveRequested || liveEffective")
    expect(engineStates).toContain("live: buildModeState(flagLive, liveEffective)")
    expect(activeCard).toContain("const liveTradeUiFlag")
    expect(activeCard).toContain("toBoolean(details?.live_trade_requested) || toBoolean(details?.is_live_trade)")
    expect(activeCard).toContain("const requestedState = typeof data.live_trade_requested === \"boolean\" ? data.live_trade_requested : newState")
    expect(optionsBar).toContain("const liveRequested = toBooleanFlag(conn.live_trade_requested)")
    expect(optionsBar).toContain("setControlOrders(liveRequested || liveEffective)")
    expect(quickstart).toContain("const liveTradeUiFlag = (conn: any): boolean")
    expect(quickstart).toContain("setLiveTradeActive(liveTradeUiFlag(conn))")
  })


  test("live-trade enable updates global operator intent to running", () => {
    const source = read("app/api/settings/connections/[id]/live-trade/route.ts")
    const intentBlock = source.slice(
      source.indexOf('await getRedisClient().hset("trade_engine:global"'),
      source.indexOf('}).catch((stateErr: unknown)', source.indexOf('await getRedisClient().hset("trade_engine:global"')),
    )

    expect(intentBlock).toContain('status: "running"')
    expect(intentBlock).toContain('desired_status: "running"')
    expect(intentBlock).toContain('operator_intent: "running"')
    expect(intentBlock).toContain('mode: hasCredentials ? "live" : "live_requested"')
  })

  test("live-trade queued starts use per-connection refresh requests consumed by coordinator", () => {
    const source = read("app/api/settings/connections/[id]/live-trade/route.ts")

    expect(source).toContain("queueEngineRefreshRequest({")
    expect(source).toContain("state_switch_version: stateSwitchVersion")
    expect(source).not.toContain('hset("engine_coordinator:refresh_requested"')
    expect(source).toContain('engineStatus = "queued"')
  })

  test("production healing sweep drains queued engine refresh requests", () => {
    const source = read("lib/trade-engine-auto-start.ts")

    expect(source).toContain("processQueuedEngineRefreshRequests")
    expect(source).toContain("getQueuedEngineRefreshRequests")
    expect(source).toContain("currentVersion !== requestedVersion")
    expect(source).toContain("await coordinator.stopEngine(request.connectionId, { operatorRequested: true })")
    expect(source).toContain("await coordinator.startMissingEngines([connection])")
    expect(source).toContain("queuedRefreshProcessedCount")
  })

  test("live-trade enable preserves requested state when credentials are missing", () => {
    const source = read("app/api/settings/connections/[id]/live-trade/route.ts")

    expect(source).toContain("BASE_CONNECTION_CREDENTIALS[connectionId as keyof typeof BASE_CONNECTION_CREDENTIALS]?.apiKey")
    expect(source).toContain('liveTradeBlockedReason = "API credentials required for live trading"')
    expect(source).toContain("is_live_trade: toRedisFlag(isLiveTrade && hasCredentials)")
    expect(source).toContain('live_trade_requested: "1"')
    expect(source).not.toContain('...(isLiveTrade ? { live_trade_blocked_reason: "" } : {})')
    expect(source).not.toContain('error: "API credentials required for live trading"')
  })

  test("global start preserves credential-gated live trade updates", () => {
    const source = read("app/api/trade-engine/start/route.ts")

    expect(source).toContain("const liveTradeUpdate = credentialCheck.valid")
    expect(source).toContain("...liveTradeUpdate")
    expect(source).toContain('is_live_trade: credentialCheck.valid ? "1" : "0"')
    expect(source).toContain('live_trade_blocked_reason: credentialCheck.valid ? "" : credentialCheck.reason')
    expect(source).not.toMatch(/\.\.\.liveTradeUpdate,[\s\S]{0,160}is_live_trade:\s*"1"/)
  })

  test("stopEngine runtime cleanup preserves Main Connection assignment fields", () => {
    const source = read("lib/trade-engine.ts")
    const cleanupStart = source.indexOf("private async cleanupStoppedRuntimeState")
    expect(cleanupStart).toBeGreaterThan(0)
    const cleanup = source.slice(cleanupStart, source.indexOf("\n  /**", cleanupStart + 1))

    expect(cleanup).toContain("engine_is_running")
    expect(cleanup).toContain("status: \"stopped\"")
    expect(cleanup).not.toMatch(/is_active_inserted\s*:/)
    expect(cleanup).not.toMatch(/is_active\s*:/)
    expect(cleanup).not.toMatch(/is_assigned\s*:/)
    expect(cleanup).not.toMatch(/is_dashboard_inserted\s*:/)
  })

  test("QuickStart symbol totals are epoch-owned to reject stale workers after processing starts", () => {
    const quickStart = read("app/api/trade-engine/quick-start/route.ts")
    const processor = read("lib/trade-engine/config-set-processor.ts")
    const engineManager = read("lib/trade-engine/engine-manager.ts")

    expect(quickStart).toContain("symbol_selection_epoch")
    expect(quickStart).toContain("quickstart_symbol_count")
    expect(processor).toContain("stillOwnsCurrentSelection")
    expect(processor).toContain("ownsCanonicalSymbolSelectionEpoch")
    expect(engineManager).toContain("ownsCanonicalSymbolSelectionEpoch")
  })

  test("settings save marks dirty, invalidates strategy/coordination caches, and triggers immediate processing", () => {
    const coordinator = read("lib/settings-coordinator.ts")
    const recoordinator = read("lib/connection-recoordinator.ts")

    expect(coordinator).toContain("settings:dirty:${connectionId}")
    expect(recoordinator).toContain("invalidateStrategyAndCoordinationCaches")
    expect(recoordinator).toContain("applyPendingChangesNow")
    const settingsCoordinator = read("lib/settings-coordinator.ts")
    expect(settingsCoordinator).toContain("settings:settings_change:${connectionId}")
    expect(settingsCoordinator).not.toContain("setSettings(`settings_change:${connectionId}`, null)")
    expect(recoordinator).toContain("ProfitFactor")
    expect(recoordinator).toContain("Drawdown")
    expect(recoordinator).toContain("variant")
    expect(recoordinator).toContain("axis")
  })

  test("disabling one connection does not stop the global coordinator", () => {
    const source = read("app/api/settings/connections/[id]/toggle-dashboard/route.ts")
    const disableBranch = source.slice(
      source.indexOf('} else if (engineAction === "stop")'),
      source.indexOf("const wasChange", source.indexOf('} else if (engineAction === "stop")')),
    )

    expect(disableBranch).toContain("Only /api/trade-engine/stop owns global shutdown")
    expect(disableBranch).toContain('status: disableGlobalState?.status || "running"')
    expect(disableBranch).not.toContain('if (activeCount === 0) return "stopped"')
  })

  test("explicit dashboard enable starts coordinator in production-safe foreground", () => {
    const source = read("app/api/settings/connections/[id]/toggle-dashboard/route.ts")
    const startBranch = source.slice(
      source.indexOf('if (engineAction === "start")'),
      source.indexOf('} else if (engineAction === "stop")'),
    )

    expect(startBranch).toContain('status: "running"')
    expect(startBranch).toContain('coordinator_ready: "true"')
    expect(startBranch).toContain("const started = await coordinator.startEngine")
    expect(startBranch).toContain('const localStartAllowed = true')
    expect(startBranch).toContain('allowInProcessStart: true')
    expect(startBranch).not.toContain("setImmediate")
  })

  test("indication windows use idempotent per-symbol fields", () => {
    const processor = read("lib/indication-sets-processor.ts")
    const cron = read("app/api/cron/generate-indications/route.ts")
    const tracking = read("lib/detailed-tracking.ts")

    expect(processor).toContain("[`${symbol}:move`]: String(moveQ)")
    expect(processor).not.toContain('pipe.hincrby(w5Key,  "move"')
    expect(cron).toContain("pipeline.hset(w5Key,  `${symbol}:${type}`, String(count))")
    expect(cron).toContain("Zeroes are written too")
    expect(tracking).toContain("aggregateWindowByType")
    expect(tracking).toContain("prefer the per-symbol snapshot")
    expect(tracking).toContain("if (idx <= 0 && hasSymbolField[type]) continue")
  })


  test("QuickStart resolves four-symbol volatility order without HTTP self-fetch", () => {
    const source = read("app/api/trade-engine/quick-start/route.ts")

    expect(source).toContain('import { fetchTopSymbols, normaliseSort } from "@/lib/top-symbols"')
    expect(source).toContain('normaliseSort(body.symbolOrder || body.symbol_order || "volatility_1h")')
    expect(source).toContain("fetchTopSymbols(exchangeName, requestedCount, requestedSymbolOrder)")
    expect(source).toContain("symbol_order: requestedSymbolOrder")
    expect(source).toContain("dev_symbol_count_override: String(symbols.length)")
    expect(source).not.toContain("/api/exchange/${exchangeName}/top-symbols?limit=${requestedCount}&sort=volatility")
  })

  test("live-trade enable awaits production-safe engine start", () => {
    const source = read("app/api/settings/connections/[id]/live-trade/route.ts")

    expect(source).toContain('export const runtime = "nodejs"')
    expect(source).toContain("const started = await coordinator.startEngine")
    expect(source).toContain('const localStartAllowed = true')
    expect(source).toContain('reason: "live_trade_enable"')
    expect(source).toContain('allowInProcessStart: true')
    expect(source).toContain('live_trade_requested: "1"')
    expect(source).toContain('mode: hasCredentials ? "live" : "live_requested"')
    expect(source).not.toContain("setImmediate")
  })


  test("live requested mode bootstraps Main and Real evaluation gates", () => {
    const source = read("lib/strategy-coordinator.ts")

    expect(source).toContain("isTruthyFlag(conn?.live_trade_requested)")
    expect(source).toContain("const mainMinPos = liveQuickstartOn")
    expect(source).toContain("? 1")
    expect(source).toContain("realMinPos = 1")
    expect(source).toContain("const relaxed = Math.min(realMinPF, 0.75)")
  })





  test("live position APIs separate real exchange data from simulated history", () => {
    const liveRoute = read("app/api/trading/live-positions/route.ts")
    const exchangeRoute = read("app/api/exchange-positions/route.ts")
    const tradingStatsRoute = read("app/api/trading/stats/route.ts")
    const symbolStatsRoute = read("app/api/exchange-positions/symbols-stats/route.ts")

    expect(liveRoute).toContain('searchParams.get("connection_id") || searchParams.get("connectionId")')
    expect(liveRoute).toContain("realPositions")
    expect(liveRoute).toContain("simulatedPositions")
    expect(liveRoute).toContain("dataIntegrity")
    expect(liveRoute).toContain("effectivePnL")
    expect(exchangeRoute).toContain('searchParams.get("connection_id") || searchParams.get("connectionId")')
    expect(exchangeRoute).toContain('source: "exchange_position_manager"')
    expect(tradingStatsRoute).toContain('source: "exchange_live_positions"')
    expect(tradingStatsRoute).toContain("simulatedExcluded: true")
    expect(tradingStatsRoute).not.toContain("FROM pseudo_positions")
    expect(symbolStatsRoute).toContain('source: "exchange_live_positions"')
    expect(symbolStatsRoute).not.toContain("For now, return mock symbols")
  })

  test("pseudo position close PnL and PF inputs are net of 0.1% position cost", () => {
    const helper = read("lib/pseudo-position-costs.ts")
    const pseudoManager = read("lib/trade-engine/pseudo-position-manager.ts")
    const posHistory = read("lib/pos-history.ts")
    const configProcessor = read("lib/trade-engine/config-set-processor.ts")
    const strategyConfig = read("lib/strategy-config-manager.ts")

    expect(helper).toContain("PSEUDO_POSITION_CLOSE_COST_RATIO = 0.001")
    expect(helper).toContain("const netPnl = grossPnl - positionCost")
    expect(helper).toContain("netPnlPct")
    expect(pseudoManager).toContain("calculatePseudoClosePnl({ entryPrice, currentPrice, quantity, side })")
    expect(pseudoManager).toContain("realized_pnl: String(pnl)")
    expect(pseudoManager).toContain("gross_realized_pnl: String(grossPnl)")
    expect(pseudoManager).toContain("position_cost_ratio: String(PSEUDO_POSITION_CLOSE_COST_RATIO)")
    expect(posHistory).toContain("PnL is already cost-adjusted")
    expect(configProcessor).toContain("netPnlPct")
    expect(strategyConfig).toContain("calculatePseudoClosePnl")
  })

  test("simulated live stage does not create duplicate open slots", () => {
    const source = read("lib/trade-engine/stages/live-stage.ts")

    expect(source).toContain("existingSimulatedSlot")
    expect(source).toContain("simulated slot already open")
    expect(source).toContain("existingSimulatedSlot,")
    expect(source).toContain('"simulate_skip"')
  })

  test("dev symbol cap honors QuickStart multi-symbol override", () => {
    const source = read("lib/trade-engine/engine-manager.ts")

    expect(source).toContain("dev_symbol_count_override")
    expect(source).toContain('process.env.V0_DEV_SYMBOL_COUNT ?? "1"')
    expect(source).toContain('if (devCap === 1) return ["BTCUSDT"]')
  })

  test("progression trade counters clamp impossible success rates after resets", () => {
    const source = read("lib/progression-state-manager.ts")

    expect(source).toContain("boundedSuccessfulTrades")
    expect(source).toContain("maxPossibleSuccessfulTrades")
    expect(source).toContain("Math.max(0, newTotalTrades - 1)")
    expect(source).toContain("tradeUpdate.successful_trades = String(boundedSuccessfulTrades)")
    expect(source).toContain("Success Rate: ${tradeSuccessRate.toFixed(1)}%")
  })

  test("startEngine leaves healthy cross-worker startup locks untouched", () => {
    const source = read("lib/trade-engine.ts")
    const lockBranch = source.slice(
      source.indexOf("Cannot start engine ${connectionId}"),
      source.indexOf("lockHandle = acquired.handle"),
    )

    expect(lockBranch).toContain("Leaving existing owner untouched")
    expect(lockBranch).toContain("return false")
    expect(lockBranch).not.toContain("forceBreakProgressionLock")
    expect(lockBranch).not.toContain("stopEngine(connectionId)")
  })

  test("startMissingEngines keeps the Main pipeline running without credentials", () => {
    const source = read("lib/trade-engine.ts")

    expect(source).toContain("engine_starting_without_credentials")
    expect(source).toContain("exchange order placement remains credential-gated")
    expect(source).not.toContain("Engine start skipped - missing credentials")
  })

  test("base pseudo-position step range includes the requested 2-step floor", () => {
    const manager = read("lib/indication-config-manager.ts")
    const settingsTab = read("components/settings/tabs/strategy-tab.tsx")
    const coordinationSection = read("components/settings/strategy-coordination-section.tsx")

    expect(manager).toContain("parsed >= 2 && parsed <= 30")
    expect(manager).toContain("const ALL_STEPS = [2, 3, 5, 10, 15, 20, 25, 30]")
    expect(settingsTab).toContain("Minimum pseudo-position step-window size (Steps 2–30).")
    expect(settingsTab).toContain("min={2}")
    expect(coordinationSection).toContain("2–30, step 1")
    expect(coordinationSection).toContain("Setting to 2 adds the fastest 2 and 3 step windows")
  })

  test("standard, axis and trailing sets are ordered before adjust variants", () => {
    const source = read("lib/strategy-coordinator.ts")

    expect(source).toContain("Operator rule: process the Standard strategy outputs first")
    expect(source).toContain("const mainSetOrder = (set: StrategySet): number")
    expect(source).toContain('if (set.variant === "trailing") return 2')
    expect(source).toContain('if (set.variant === "block") return 3')
    expect(source).toContain('if (set.variant === "dca") return 4')
    expect(source).toContain("mainSets.sort((a, b) => mainSetOrder(a) - mainSetOrder(b))")
  })

  test("trailing is coordinated at Base and is not emitted as a Main adjust variant", () => {
    const source = read("lib/strategy-coordinator.ts")

    expect(source).toContain("trailing is NOT a")
    expect(source).toContain("Main-stage Adjust strategy")
    expect(source).toContain("Trailing is coordinated at BASE")
    expect(source).toContain('if (p.name === "trailing") return false')
    expect(source).toContain('const variantsForThisBase = activeVariants.filter((p) => p.name !== "block")')
    expect(source).toContain("do not special-case trailingProfile here")
    expect(source).toContain("legacy placeholder only; real trailing Sets are created at BASE")
  })

  test("block overlays completed-position counts and active-position exposure at Real stage", () => {
    const source = read("lib/strategy-coordinator.ts")

    expect(source).toContain("Block is not materialized as its own Main/Real Set")
    expect(source).toContain('activeVariants.filter((p) => p.name !== "block")')
    expect(source).toContain("EVERY block size [1..blockMaxStack]")
    expect(source).toContain("blockMaxStack:    10")
    expect(source).toContain("Math.max(1, Math.min(8, this._coordinationSettings.blockMaxStack | 0))")
    expect(source).toContain("for (let blockCount = 1; blockCount <= maxStack; blockCount++)")
    expect(source).toContain("setKey: `${source.setKey}#block:${blockCount}`")
    expect(source).toContain("Active Real/Live-position Block handling belongs to REAL")
    expect(source).toContain("buildActiveRealBlockOverlaysForReal")
    expect(source).toContain("blockActiveRealEnabled && !this._coordinationSettings.blockActiveLiveEnabled")
    expect(source).toContain("setKey: `${source.setKey}#block:active:${boundedCount}`")
    expect(source).toContain("variantSizeMultiplier: Number((blockConfig.size * blockMul).toFixed(6))")
    expect(source).toContain("variant: \"block\"")
  })

  test("block pause count ratio is persisted and clamped for strategy settings", () => {
    const section = read("components/settings/strategy-coordination-section.tsx")
    const route = read("app/api/settings/connections/[id]/settings/route.ts")
    const coordinator = read("lib/strategy-coordinator.ts")

    expect(section).toContain("blockPauseCountRatio: number")
    expect(section).toContain("blockActiveRealEnabled: boolean")
    expect(section).toContain("blockMaxStack:    10")
    expect(section).toContain("max={10}")
    expect(section).toContain("min={1}")
    expect(section).toContain("Pause Count Ratio")
    expect(section).toContain("Active Real Position Block")
    expect(route).toContain("flatKnobs.blockPauseCountRatio")
    expect(route).toContain("flatKnobs.blockActiveRealEnabled")
    expect(route).toContain("Math.min(10, Math.max(1, Math.floor(bms)))")
    expect(coordinator).toContain("this._coordinationSettings.blockPauseCountRatio")
    expect(coordinator).toContain("this._coordinationSettings.blockActiveRealEnabled")
    expect(coordinator).toContain("Math.max(1, Math.min(4, Math.round(bpcr * 2) / 2))")
    expect(section).toContain("blockActiveLiveEnabled: boolean")
    expect(section).toContain("Pause Count Ratio")
    expect(section).toContain("Active Live Position Block")
    expect(route).toContain("flatKnobs.blockPauseCountRatio")
    expect(route).toContain("flatKnobs.blockActiveLiveEnabled")
    expect(coordinator).toContain("this._coordinationSettings.blockPauseCountRatio")
    expect(coordinator).toContain("this._coordinationSettings.blockActiveLiveEnabled")
    expect(coordinator).toContain("Math.max(1, Math.min(4, Math.round(bpcr * 2) / 2))")
  })

  test("production strategy fan-out has env-overridable liveness ceilings", () => {
    const source = read("lib/strategy-coordinator.ts")

    expect(source).toContain("STRATEGY_MAIN_AXIS_SETS_CEILING")
    expect(source).toContain(": 50")
    expect(source).toContain("STRATEGY_REAL_SETS_SAFETY_CEILING")
    expect(source).toContain(": 100")
    expect(source).toContain("private static readonly _AXIS_LRU_MAX = (() =>")
  })

  test("coordinator startEngine allows production in-process starts by default", () => {
    const source = read("lib/trade-engine.ts")

    expect(source).toContain("Production must allow in-process starts from the coordinator")
    expect(source).toContain("Duplicate starts")
    expect(source).not.toContain('startEngine(${connectionId}) queued/skipped because in-process start was not explicitly allowed')
  })

  test("base connection migrations preserve existing live-trade operator state", () => {
    const source = read("lib/redis-migrations.ts")
    const existingBlock = source.slice(
      source.indexOf("Existing connection: repair missing selection defaults only."),
      source.indexOf("// Existing connection: PRESERVE every operator-controlled field."),
    )

    expect(existingBlock).toContain("Never re-enable `is_live_trade` here")
    expect(existingBlock).toContain('existing row with')
    expect(existingBlock).toContain("const needsSelectionRepair =")
    expect(existingBlock).toContain("!hasOrder || !existing")
    expect(existingBlock).toContain('if (cfg.autoActive && cfg.exchange === "bingx" && needsSelectionRepair)')
    expect(existingBlock).toContain('patchData["symbol_order"] = "volatility_1h"')
    expect(existingBlock).not.toContain('patchData["is_live_trade"] = "1"')
    expect(existingBlock).not.toContain("!hasLiveTrade")
  })

  test("production web boot enables in-process starts and continuity by default", () => {
    const instrumentation = read("instrumentation.ts")
    const continuityRunner = read("lib/server-continuity-runner.ts")

    expect(instrumentation).toContain('process.env.NEXT_RUNTIME === "edge"')
    expect(instrumentation).not.toContain('process.env.NEXT_RUNTIME !== "nodejs"')
    expect(instrumentation).toContain('DISABLE_TRADE_ENGINE_AUTOSTART !== "1"')
    expect(instrumentation).toContain('DISABLE_IN_PROCESS_CONTINUITY !== "1"')
    expect(continuityRunner).toContain('DISABLE_IN_PROCESS_CONTINUITY === "1"')
    expect(continuityRunner).toContain("Long-lived Node production/dev processes should keep continuity alive")
  })

  test("indication snapshots do not double-count legacy production fields", () => {
    const detailedTracking = read("lib/detailed-tracking.ts")
    const statsRoute = read("app/api/connections/progression/[id]/stats/route.ts")
    const migrations = read("lib/redis-migrations.ts")

    expect(detailedTracking).toContain("const byType = aggregateWindowByType(active)")
    expect(detailedTracking).not.toContain("const aggregateWindowByType = (hash: Record<string, string>): Record<string, number> =>")
    expect(statsRoute).toContain("function aggregateIndicationSnapshot")
    expect(statsRoute).toContain("ignore the plain field so mixed deploys do not double")
    expect(migrations).toContain('name: "063-reset-legacy-indication-snapshots"')
    expect(migrations).toContain('"indications_active:*"')
    expect(migrations).toContain('"indications_window:*:last5"')
    expect(migrations).toContain("do NOT touch cumulative progression counters")
  })

  test("indication processing keeps every type independent and windowed", () => {
    const setProcessor = read("lib/indication-sets-processor.ts")
    const rawProcessor = read("lib/trade-engine/indication-processor-fixed.ts")

    expect(setProcessor).toContain('runType("active_advanced", () => this.processActiveAdvancedSet(symbol, marketData))')
    expect(setProcessor).toContain("private async processActiveAdvancedSet")
    expect(setProcessor).toContain('await this.batchSaveIndications(pendingWrites, "active_advanced")')
    expect(setProcessor).toContain('active_advanced: activeAdvancedResults')
    expect(setProcessor).toContain('`${symbol}:active_advanced`]: String(advQ)')
    expect(rawProcessor).toContain("active_advanced: 0")
    expect(rawProcessor).toContain('const w5Key = `indications_window:${this.connectionId}:last5`')
    expect(rawProcessor).toContain("pipe.hset(w5Key, fields)")
    expect(rawProcessor).toContain("pipe.hset(w60Key, fields)")
  })

  test("server continuity cron awaits direct healing sweep instead of relying on auto-start timers", () => {
    const cronRoute = read("app/api/cron/server-continuity/route.ts")
    const autoStart = read("lib/trade-engine-auto-start.ts")

    expect(autoStart).toContain("export async function runTradeEngineHealingSweep")
    expect(autoStart).toContain("armTimer = false")
    expect(autoStart).toContain("await runTradeEngineHealingSweep({ isStartup: true, armTimer: true })")
    expect(cronRoute).toContain("runTradeEngineHealingSweep")
    expect(cronRoute).toContain('runCronTask("auto-start-healing-sweep", () => runTradeEngineHealingSweep({ isStartup: true }))')
    expect(cronRoute).not.toContain("initializeTradeEngineAutoStart")
  })

  test("Cloudflare deployment has scheduled continuity worker config", () => {
    const wrangler = read("wrangler.jsonc")
    const customWorker = read("custom-worker.ts")

    expect(wrangler).toContain('"main": "./custom-worker.ts"')
    expect(wrangler).toContain('"compatibility_flags": ["nodejs_compat"]')
    expect(wrangler).toContain('"crons": ["* * * * *"]')
    expect(customWorker).toContain("fetch: handler.fetch")
    expect(customWorker).toContain("async scheduled")
    expect(customWorker).toContain("/api/cron/server-continuity")
    expect(customWorker).toContain("/api/cron/sync-live-positions")
  })

  test("production continuity cron awaits a real auto-start sweep before returning", () => {
    const cron = read("app/api/cron/server-continuity/route.ts")
    const autoStart = read("lib/trade-engine-auto-start.ts")

    expect(autoStart).toContain("export async function runTradeEngineHealingSweep")
    expect(autoStart).toContain("Cron/serverless routes must call this directly and await it")
    expect(cron).toContain('runCronTask("auto-start-healing-sweep", () => runTradeEngineHealingSweep({ isStartup: true }))')
    expect(cron).not.toContain("initializeTradeEngineAutoStart")
  })

  test("status route does not report stale Redis running intent as local engine progress", () => {
    const source = read("app/api/trade-engine/status/route.ts")

    expect(source).toContain("const coordinatorEngineCount = coordinator?.getActiveEngineCount() || 0")
    expect(source).toContain("const hasLocalEngineRuntime = coordinatorEngineCount > 0")
    expect(source).toContain("const hasFreshDistributedHeartbeat")
    expect(source).toContain("hasLocalEngineRuntime || hasFreshDistributedHeartbeat")
    expect(source).toContain("workerAttached: hasLocalEngineRuntime")
    expect(source).toContain("distributedHeartbeatFresh: hasFreshDistributedHeartbeat")
    expect(source).toContain("distributedEngineCount")
    expect(source).toContain("No local engine runtime is attached yet; explicit UI actions and continuity sweeps will reconcile queued engine work.")
    expect(source).toContain("Optional for always-on processing")
    expect(source).toContain("operatorStatus: operatorIntent")
    expect(source).not.toContain("Math.max(coordinatorEngineCount, summary.running)")
  })

  test("startup lock preserves a fresh remote engine owner instead of clearing its Redis flag", () => {
    const source = read("lib/trade-engine.ts")

    expect(source).toContain("const remoteHeartbeatFresh")
    expect(source).toContain("Date.now() - remoteHeartbeat < 90_000")
    expect(source).toContain("is owned by another worker with a fresh heartbeat")
    expect(source).toContain("not clearing distributed running flag")
  })


  test("restart from non-owner preserves fresh remote progression lock", () => {
    const source = read("lib/trade-engine.ts")
    const restartBlock = source.slice(
      source.indexOf("async restartEngine(connectionId: string): Promise<void>"),
      source.indexOf("private async markRemoteRestartRequestIfFresh"),
    )

    expect(restartBlock).toContain("hasLocalRunningManager")
    expect(restartBlock).toContain("stop normally so the manager releases its own")
    expect(restartBlock).toContain("markRemoteRestartRequestIfFresh(connectionId)")
    expect(restartBlock).toContain("remote owner has fresh heartbeat")
    expect(restartBlock).toContain("treat the distributed")
    expect(restartBlock).toContain("forceBreakProgressionLock(connectionId)")
    expect(restartBlock.indexOf("markRemoteRestartRequestIfFresh(connectionId)")).toBeLessThan(
      restartBlock.indexOf("forceBreakProgressionLock(connectionId)"),
    )
  })

  test("fresh remote restart marker path does not force-break progression lock", () => {
    const source = read("lib/trade-engine.ts")
    const markerBlock = source.slice(
      source.indexOf("private async markRemoteRestartRequestIfFresh"),
      source.indexOf("async applyPendingChangesNow"),
    )

    expect(markerBlock).toContain("Date.now() - remoteHeartbeat < 90_000")
    expect(markerBlock).toContain("restart_request")
    expect(markerBlock).toContain("settings_change_marker")
    expect(markerBlock).not.toContain("forceBreakProgressionLock")
  })

  test("settings save does not auto-start heavy engine loops in an unopted web worker", () => {
    const source = read("lib/connection-recoordinator.ts")

    expect(source).toContain('process.env.ENABLE_TRADE_ENGINE_AUTOSTART === "1" || coordinator.isRunning()')
    expect(source).toContain("web worker has no local engine runtime/opt-in")
    expect(source).toContain("settings apply on next explicit Start or dedicated worker tick")
  })

  test("dashboard enable starts from explicit UI action without requiring worker env", () => {
    const source = read("app/api/settings/connections/[id]/toggle-dashboard/route.ts")

    expect(source).toContain('const localStartAllowed = true')
    expect(source).toContain('allowInProcessStart: true')
    expect(source).toContain('const started = await coordinator.startEngine')
    expect(source).toContain('engineStatus = "started"')
  })

  test("connection enable paths keep global coordinator intent stable when engines can run", () => {
    const enableRoute = read("app/api/settings/connections/[id]/enable/route.ts")
    const dashboardRoute = read("app/api/settings/connections/[id]/toggle-dashboard/route.ts")

    expect(enableRoute).toContain('hgetall("trade_engine:global")')
    expect(enableRoute).toContain('status: "running"')
    expect(enableRoute).toContain('desired_status: "running"')
    expect(enableRoute).toContain('operator_intent: "running"')
    expect(enableRoute).toContain('coordinator_ready: "true"')
    expect(enableRoute.indexOf('operator_intent: "running"')).toBeLessThan(enableRoute.indexOf("await coordinator.startMissingEngines"))

    expect(dashboardRoute).toContain("const preservedCoordinatorIntent")
    expect(dashboardRoute).toContain("desired_status: disableGlobalState?.desired_status || preservedCoordinatorIntent")
    expect(dashboardRoute).toContain("operator_intent: disableGlobalState?.operator_intent || preservedCoordinatorIntent")
    expect(dashboardRoute).toContain("Only /api/trade-engine/stop owns global shutdown")
  })

  test("dashboard detailed logs header action scrolls within the log dialog", () => {
    const button = read("components/dashboard/detailed-logs-button.tsx")
    const scrollArea = read("components/ui/scroll-area.tsx")
    const dashboard = read("components/dashboard/dashboard.tsx")

    expect(dashboard).toContain("<DetailedLogsButton />")
    expect(button).toContain("scrollContainerRef.current?.scrollTo({ top: 0, behavior: \"smooth\" })")
    expect(button).toContain("viewportRef={scrollContainerRef}")
    expect(scrollArea).toContain("viewportRef?: React.Ref<HTMLDivElement>")
    expect(scrollArea).toContain("ref={viewportRef}")
  })
  test("startup intent without worker heartbeat reports degraded/not running", () => {
    const startup = read("lib/startup-coordinator.ts")
    const statusRoute = read("app/api/trade-engine/status/route.ts")

    const bootBlock = startup.slice(
      startup.indexOf("Initializing global trade engine boot metadata"),
      startup.indexOf("Step 7/8", startup.indexOf("Initializing global trade engine boot metadata")),
    )

    expect(bootBlock).toContain('desired_status: "running"')
    expect(bootBlock).toContain('operator_intent: "running"')
    expect(bootBlock).toContain('actual_status: "stopped"')
    expect(bootBlock).not.toMatch(/^\s*status: "running"/m)

    expect(statusRoute).toContain("const effectivelyRunning = isGloballyRunning && !isGloballyPaused && (hasRuntimeProof || distributedEngineCount > 0)")
    expect(statusRoute).toContain('actualStatus: effectivelyRunning ? "running" : (isGloballyPaused ? "paused" : "degraded")')
    expect(statusRoute).toContain("last_heartbeat_at")
  })

})
