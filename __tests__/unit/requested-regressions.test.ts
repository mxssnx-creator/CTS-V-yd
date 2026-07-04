import fs from "fs"
import path from "path"

const repo = path.resolve(__dirname, "../..")
const read = (file: string) => fs.readFileSync(path.join(repo, file), "utf8")

describe("requested regression guardrails", () => {
  test("real progression evaluated includes fan-out without impossible-state clamp", () => {
    const coordinator = read("lib/strategy-coordinator.ts")
    const statsRoute = read("app/api/connections/progression/[id]/stats/route.ts")

    expect(coordinator).toContain("let realStageRelatedCreated = 0")
    expect(coordinator).toContain("realStageRelatedCreated += activePositionBlockOverlays.length")
    expect(coordinator).toContain("const realRelatedCreated = Math.max(0, realSets.length - mainPFEligible)")
    expect(coordinator).toContain("const realTotalEvaluated = mainPFEligible + realRelatedCreated")
    expect(coordinator).toContain('`${symbol}:real:input`')
    expect(coordinator).toContain('`${symbol}:real:relatedCreated`')
    expect(coordinator).toContain('`${symbol}:real:evaluated`]: String(realTotalEvaluated)')

    expect(statsRoute).toContain("let activeRealInput = 0")
    expect(statsRoute).toContain("let activeRealRelatedCreated = 0")
    expect(statsRoute).toContain("const realUpstreamInput = activeRealInput || stratCounts.main")
    expect(statsRoute).toContain('suffix === "real:input"')
    expect(statsRoute).toContain('suffix === "real:relatedCreated"')
    expect(statsRoute).toContain("const afterFanOut = activeRealInput + activeRealRelatedCreated")
    expect(statsRoute).toContain("const realMaxAfterFanOut = realUpstreamInput + activeRealRelatedCreated")
    expect(statsRoute).not.toContain("stratCounts.real > stratCounts.main) {")

    const snapshot = { main: 10, realRelatedCreated: 5, real: 12 }
    const realEvaluated = snapshot.main + snapshot.realRelatedCreated
    const shouldClampImpossibleState = snapshot.real > snapshot.main + snapshot.realRelatedCreated
    expect(realEvaluated).toBe(15)
    expect(shouldClampImpossibleState).toBe(false)
  })


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
    expect(source).not.toContain('error: "API credentials required for live trading"')
  })

  test("global start preserves credential-gated live trade updates", () => {
    const source = read("app/api/trade-engine/start/route.ts")

    expect(source).toContain("const liveTradeUpdate = credentialCheck.valid")
    expect(source).toContain("...liveTradeUpdate")
    expect(source).toContain('is_live_trade: credentialCheck.valid ? "1" : "0"')
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

  test("explicit dashboard enable queues in production and foreground-starts only with opt-in", () => {
    const source = read("app/api/settings/connections/[id]/toggle-dashboard/route.ts")
    const startBranch = source.slice(
      source.indexOf('if (engineAction === "start")'),
      source.indexOf('} else if (engineAction === "stop")'),
    )

    expect(startBranch).toContain('status: "running"')
    expect(startBranch).toContain('coordinator_ready: "true"')
    expect(startBranch).toContain("const engineStarted = await coordinator.startEngine")
    expect(startBranch).toContain('process.env.ALLOW_API_TRADE_ENGINE_FOREGROUND === "1"')
    expect(startBranch).toContain('process.env.ENABLE_TRADE_ENGINE_IN_PROCESS === "1"')
    expect(startBranch).toContain('engineStatus = "queued"')
    expect(startBranch).toContain('allowInProcessStart: true')
    expect(startBranch).not.toContain("setImmediate")
  })

  test("indication windows use idempotent per-symbol fields", () => {
    const processor = read("lib/indication-sets-processor.ts")
    const cron = read("app/api/cron/generate-indications/route.ts")
    const tracking = read("lib/detailed-tracking.ts")

    expect(processor).toContain("[`${symbol}:move`]: String(moveQ)")
    expect(processor).not.toContain('pipe.hincrby(w5Key,  "move"')
    expect(cron).toContain("runIndStratCycle(connectionId, symbol, \"realtime\"")
    expect(cron).toContain("ensureCurrentMarketDataCandle(symbol, client)")
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

  test("live-trade enable queues in production and foreground-starts only with opt-in", () => {
    const source = read("app/api/settings/connections/[id]/live-trade/route.ts")

    expect(source).toContain('export const runtime = "nodejs"')
    expect(source).toContain("const engineStarted = await coordinator.startEngine")
    expect(source).toContain('process.env.ALLOW_API_TRADE_ENGINE_FOREGROUND === "1"')
    expect(source).toContain('process.env.ENABLE_TRADE_ENGINE_IN_PROCESS === "1"')
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
    const statsRoute = read("app/api/connections/progression/[id]/stats/route.ts")

    expect(source).toContain("Block is not materialized as its own Main/Real Set")
    expect(source).toContain('activeVariants.filter((p) => p.name !== "block")')
    expect(source).toContain("EVERY block size [1..blockMaxStack]")
    expect(source).toContain("blockMaxStack:    10")
    expect(source).toContain("Math.max(1, Math.min(10, this._coordinationSettings.blockMaxStack | 0))")
    expect(source).toContain("for (let blockCount = 1; blockCount <= maxStack; blockCount++)")
    expect(source).toContain("setKey: `${source.setKey}#block:${blockCount}`")
    expect(source).toContain("Active Real/Live-position Block handling belongs to REAL")
    expect(source).toContain("buildActiveRealBlockOverlaysForReal")
    expect(source).toContain("blockActiveRealEnabled && !this._coordinationSettings.blockActiveLiveEnabled")
    expect(source).toContain("setKey: `${source.setKey}#block:active:${boundedCount}`")
    expect(statsRoute).toContain("const realValidatedActivePositions = realOpen || realDetailRunning || 0")
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

  test("coordinator startEngine is queue-only in production API workers unless explicitly opted in", () => {
    const source = read("lib/trade-engine.ts")

    expect(source).toContain("private canOwnEngineRuntime()")
    expect(source).toContain('process.env.ALLOW_API_TRADE_ENGINE_FOREGROUND === "1"')
    expect(source).toContain('process.env.ENABLE_TRADE_ENGINE_IN_PROCESS === "1"')
    expect(source).toContain("queued-only in this production API worker")
    expect(source).toContain("Leaving start request queued")
    expect(source).not.toContain("runningUnderProdStart")
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
    expect(detailedTracking).toContain("indication_sets_active")
    expect(detailedTracking).toContain("indication_sets_window")
    expect(detailedTracking).toContain("Do not read the raw indications_active")
    expect(detailedTracking).toContain("last5ByType[t] = v5")
    expect(detailedTracking).toContain("const totalIndicationSets = totalActive || last5Total || 0")
    expect(detailedTracking).not.toContain("const aggregateWindowByType = (hash: Record<string, string>): Record<string, number> =>")
    expect(statsRoute).toContain("function aggregateIndicationSnapshot")
    expect(statsRoute).toContain("ignore the plain field so mixed deploys do not double")
    expect(migrations).toContain('name: "063-reset-legacy-indication-snapshots"')
    expect(migrations).toContain('name: "064-split-raw-and-set-indication-snapshots"')
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
    expect(setProcessor).toContain('const activeKey = `indication_sets_active:${this.connectionId}`')
    expect(setProcessor).toContain('const w5Key      = `indication_sets_window:${this.connectionId}:last5`')
    expect(rawProcessor).toContain("active_advanced: 0")
    expect(rawProcessor).toContain('const w5Key = `indications_window:${this.connectionId}:last5`')
    expect(rawProcessor).toContain("pipe.hset(w5Key, fields)")
    expect(rawProcessor).toContain("pipe.hset(w60Key, fields)")
  })
  test("closing pending realtime outcomes preserves LIST-backed indication sets", () => {
    const setProcessor = read("lib/indication-sets-processor.ts")
    const closeStart = setProcessor.indexOf("private async closePendingRealtimeOutcomes")
    const closeEnd = setProcessor.indexOf("private evaluateForwardOutcome", closeStart)
    const closeBlock = setProcessor.slice(closeStart, closeEnd)

    expect(closeBlock).toContain("await this.readIndicationSetEntries(client, setKey)")
    expect(closeBlock).toContain("await client.del(setKey)")
    expect(closeBlock).toContain("await client.rpush(setKey, ...serializedEntries)")
    expect(closeBlock).toContain("compactionCeiling(cfg)")
    expect(closeBlock).toContain("await client.ltrim(setKey, -cfg.floor, -1)")
    expect(closeBlock).toContain("await this.indexSetKey(client, setKey")
    expect(closeBlock).not.toContain("await client.set(setKey, JSON.stringify(entries))")
    expect(closeBlock).not.toContain("const existing = await client.get(setKey)")
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
    expect(source).toContain("No local engine runtime is attached yet; explicit UI actions and continuity sweeps will attach engine work in this process.")
    expect(source).toContain("Optional for dedicated-worker deployments")
    expect(source).toContain("operatorStatus: operatorIntent")
    expect(source).not.toContain("Math.max(coordinatorEngineCount, summary.running)")
  })



  test("settings recoordinator uses operator intent and unblocks live trade after credentials save", () => {
    const source = read("lib/connection-recoordinator.ts")

    expect(source).toContain("Live Trade unblocked")
    expect(source).toContain("operator_intent || (globalState as any)?.desired_status")
    expect(source).not.toContain("web worker has no local engine runtime/opt-in")
    expect(source).not.toContain('process.env.ENABLE_TRADE_ENGINE_AUTOSTART === "1" || coordinator.isRunning()')
  })

  test("live-trade foreground start failures do not mark the global coordinator error", () => {
    const source = read("app/api/settings/connections/[id]/live-trade/route.ts")

    expect(source).toContain("live_trade_enable_foreground_start_failed")
    expect(source).toContain('status: "running"')
    expect(source).toContain('operator_intent: "running"')
    expect(source).toContain('engineStatus = "queued"')
    expect(source).not.toContain('status: "error"')
    expect(source).not.toContain('engine_is_running:${connectionId}`')
  })

  test("startup cleanup preserves fresh distributed engine owners", () => {
    const source = read("lib/startup-coordinator.ts")
    const cleanupBlock = source.slice(
      source.indexOf("export async function cleanupOrphanedProgress"),
      source.indexOf("export async function completeStartup"),
    )

    expect(cleanupBlock).toContain("fresh distributed heartbeat present")
    expect(cleanupBlock).toContain("last_processor_heartbeat")
    expect(cleanupBlock).toContain("Date.now() - remoteHeartbeat < 90_000")
    expect(cleanupBlock.indexOf("remoteHeartbeatFresh")).toBeLessThan(cleanupBlock.indexOf("Cleaning orphaned running flag"))
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

  test("settings save start reconciliation follows global operator intent", () => {
    const source = read("lib/connection-recoordinator.ts")

    expect(source).toContain("operator_intent || (globalState as any)?.desired_status")
    expect(source).toContain("global intent=running")
    expect(source).toContain("operator stop honored")
    expect(source).not.toContain('process.env.ENABLE_TRADE_ENGINE_AUTOSTART === "1" || coordinator.isRunning()')
    expect(source).not.toContain("web worker has no local engine runtime/opt-in")
  })

  test("dashboard enable keeps API worker responsive unless foreground runtime is explicitly allowed", () => {
    const source = read("app/api/settings/connections/[id]/toggle-dashboard/route.ts")

    expect(source).toContain('process.env.ALLOW_API_TRADE_ENGINE_FOREGROUND === "1"')
    expect(source).toContain('process.env.ENABLE_TRADE_ENGINE_IN_PROCESS === "1"')
    expect(source).toContain('allowInProcessStart: true')
    expect(source).toContain('const engineStarted = await coordinator.startEngine')
    expect(source).toContain('engineStatus = "queued"')
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
    expect(enableRoute).toContain('operator_stopped: "0"')
    expect(enableRoute).toContain('const localStartAllowed =')
    expect(enableRoute).toContain('process.env.NODE_ENV !== "production"')
    expect(enableRoute).toContain('process.env.ALLOW_API_TRADE_ENGINE_FOREGROUND === "1"')
    expect(enableRoute.indexOf('operator_intent: "running"')).toBeLessThan(enableRoute.indexOf("await coordinator.startMissingEngines"))

    expect(dashboardRoute).toContain("const preservedCoordinatorIntent")
    expect(dashboardRoute).toContain("desired_status: disableGlobalState?.desired_status || preservedCoordinatorIntent")
    expect(dashboardRoute).toContain("operator_intent: disableGlobalState?.operator_intent || preservedCoordinatorIntent")
    expect(dashboardRoute).toContain('operator_stopped: "0"')
    expect(dashboardRoute).toContain("Only /api/trade-engine/stop owns global shutdown")
  })

  test("live-trade enable clears stale global operator stop latch", () => {
    const source = read("app/api/settings/connections/[id]/live-trade/route.ts")
    const enableBlock = source.slice(
      source.indexOf("if (isLiveTrade)"),
      source.indexOf("await persistNow()", source.indexOf("if (isLiveTrade)")),
    )

    expect(enableBlock).toContain('operator_intent: "running"')
    expect(enableBlock).toContain('operator_stopped: "0"')
    expect(enableBlock).toContain('operator_stopped_at: ""')
    expect(enableBlock).toContain('stopped_at: ""')
  })


  test("global resume restores Redis intent before startEngine and supports fresh-process paused state", () => {
    const resumeRoute = read("app/api/trade-engine/resume/route.ts")
    const coordinator = read("lib/trade-engine.ts")

    const routeRestoreIndex = resumeRoute.indexOf('await client.hset("trade_engine:global", {')
    const routeResumeIndex = resumeRoute.indexOf("await coordinator.resume({ force: true })")
    expect(routeRestoreIndex).toBeGreaterThanOrEqual(0)
    expect(routeRestoreIndex).toBeLessThan(routeResumeIndex)
    expect(resumeRoute).toContain('status: previousStatus')
    expect(resumeRoute).toContain('desired_status: previousStatus')
    expect(resumeRoute).toContain('operator_intent: previousStatus')

    const resumeBlock = coordinator.slice(
      coordinator.indexOf("async resume(options: { force?: boolean } = {})"),
      coordinator.indexOf("getEngineManager", coordinator.indexOf("async resume(options: { force?: boolean } = {})")),
    )
    expect(resumeBlock).toContain('const redisPaused = globalState?.status === "paused" || globalState?.operator_intent === "paused"')
    expect(resumeBlock).toContain("if (!options.force && !this.isPaused && !redisPaused)")
    expect(resumeBlock.indexOf('await client.hset("trade_engine:global", {')).toBeLessThan(resumeBlock.indexOf("await this.startEngine(connectionId, config)"))
    expect(resumeBlock).toContain('status: restoredStatus')
    expect(resumeBlock).toContain('desired_status: restoredStatus')
    expect(resumeBlock).toContain('operator_intent: restoredStatus')
    expect(resumeBlock.indexOf('await client.hdel("trade_engine:global", "paused_at", "paused_by", "previous_status")')).toBeGreaterThan(resumeBlock.indexOf('await client.hset("trade_engine:global", {'))
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

  test.each([
    ["0", false],
    ["1", true],
  ])("testing place-order forwards Redis is_testnet %s as connector isTestnet=%s", async (isTestnetFlag, expectedIsTestnet) => {
    jest.resetModules()

    const hgetall = jest.fn().mockResolvedValue({
      name: "Test Connection",
      exchange: "bingx",
      api_key: "test-api-key",
      api_secret: "test-api-secret",
      api_passphrase: "test-passphrase",
      api_type: "swap",
      contract_type: "perpetual",
      is_testnet: isTestnetFlag,
      margin_type: "cross",
      position_mode: "one_way",
      connection_method: "api",
      connection_library: "ccxt",
    })
    const hget = jest.fn().mockResolvedValue(null)
    const hincrby = jest.fn().mockResolvedValue(1)
    const hincrbyfloat = jest.fn().mockResolvedValue(1)
    const createExchangeConnector = jest.fn().mockResolvedValue({
      placeOrder: jest.fn().mockResolvedValue({ success: true, orderId: "order-1" }),
    })

    jest.doMock("@/lib/redis-db", () => ({
      initRedis: jest.fn().mockResolvedValue(undefined),
      getRedisClient: jest.fn(() => ({ hgetall, hget, hincrby, hincrbyfloat })),
      savePosition: jest.fn().mockResolvedValue(undefined),
      getMarketData: jest.fn().mockResolvedValue(null),
    }))
    jest.doMock("@/lib/exchange-connectors/factory", () => ({
      createExchangeConnector,
    }))
    jest.doMock("@/lib/live-order-safety", () => ({
      getLiveOrderSafetyFailure: jest.fn(() => null),
    }))

    const { POST } = await import("../../app/api/testing/place-order/route")

    const response = await POST({
      json: async () => ({
        connectionId: "conn-1",
        symbol: "BTCUSDT",
        side: "buy",
        quantity: 0.001,
        leverage: 1,
      }),
    } as any)
    const payload = await response.json()

    expect(payload.success).toBe(true)
    expect(createExchangeConnector).toHaveBeenCalledWith(
      "bingx",
      expect.objectContaining({
        isTestnet: expectedIsTestnet,
        apiType: "swap",
        contractType: "perpetual",
      }),
    )
  })

  test("queued settings refreshes hot-apply one connection and do not reinitialize all engines", () => {
    const coordinator = read("lib/trade-engine.ts")
    const autoStart = read("lib/trade-engine-auto-start.ts")
    const settingsCoordinator = read("lib/settings-coordinator.ts")

    const healthBlock = coordinator.slice(
      coordinator.indexOf('if (request.action === "stop")'),
      coordinator.indexOf("// -- 2. Per-engine stall watchdog", coordinator.indexOf('if (request.action === "stop")')),
    )
    expect(healthBlock).toContain("await this.applyPendingChangesNow(request.connectionId)")
    expect(healthBlock).not.toContain("await this.refreshEngines()")

    const autoBlock = autoStart.slice(
      autoStart.indexOf('if (request.action === "stop")'),
      autoStart.indexOf("return processed", autoStart.indexOf('if (request.action === "stop")')),
    )
    expect(autoBlock).toContain("await coordinator.applyPendingChangesNow?.(request.connectionId)")
    expect(autoBlock).not.toContain("await coordinator.refreshEngines()")

    const restartFields = settingsCoordinator.slice(
      settingsCoordinator.indexOf("const RESTART_REQUIRED_FIELDS"),
      settingsCoordinator.indexOf("const HOT_RELOAD_FIELDS"),
    )
    expect(restartFields).not.toContain('"is_enabled"')
    expect(settingsCoordinator).toContain('"is_enabled", "is_enabled_dashboard", "is_live_trade"')
  })

  test("QuickStart live controls send the checked state directly and revert to previous on failure", () => {
    const optionsBar = read("components/dashboard/quickstart-options-bar.tsx")
    const quickstartSection = read("components/dashboard/quickstart-section.tsx")
    const activeCard = read("components/dashboard/active-connection-card.tsx")
    const activeManager = read("components/dashboard/dashboard-active-connections-manager.tsx")

    expect(optionsBar).toContain("void debouncedSaveLive(next, previous)")
    expect(optionsBar).toContain("setControlOrders(previous)")
    expect(optionsBar).toContain("onClick={(event) => event.stopPropagation()}")
    expect(optionsBar).not.toContain("const debouncedSaveLive   = useDebouncedSaver(saveLiveTrade")

    expect(quickstartSection).toContain("const previousState = liveTradeActive")
    expect(quickstartSection).toContain("setLiveTradeActive(previousState)")
    expect(quickstartSection).toContain("live-trade-toggled")

    expect(activeCard).toContain("const previousState = liveTrade")
    expect(activeCard).toContain("setLiveTrade(previousState)")
    expect(activeCard).toContain("onCheckedChange={(checked) => {\n                    onToggle(connection.connectionId, checked)")
    expect(activeManager).toContain("const newState = desiredState")
    expect(activeManager).not.toContain("const newState = !currentState")
  })

  test("strategy set top-k selection uses a bounded heap for large progression inputs", () => {
    const source = read("lib/strategy-sets-processor.ts")
    expect(source).toContain("Memory-safe top-K selection")
    expect(source).toContain("const heap: any[] = []")
    expect(source).toContain("bubbleUp")
    expect(source).toContain("sinkDown")
    expect(source).not.toContain("top[minIdx] = indication")
  })


  test("production system monitoring returns process resource metrics even when Redis is unavailable", () => {
    const route = read("app/api/system/monitoring/route.ts")
    const helper = read("lib/system-resource-metrics.ts")

    expect(route).toContain('const resourceMetrics = getSystemResourceMetrics()')
    expect(route.indexOf('const resourceMetrics = getSystemResourceMetrics()')).toBeLessThan(route.indexOf('await initRedis()'))
    expect(route).toContain('Redis unavailable while collecting system metrics')
    expect(route).toContain('cpu: resourceMetrics.cpuPercent')
    expect(route).toContain('memory: resourceMetrics.memoryPercent')
    expect(route).not.toContain('cpu: 0,')
    expect(route).not.toContain('memory: 0,')

    expect(helper).toContain('process.cpuUsage(previous.cpuUsage)')
    expect(helper).toContain('/sys/fs/cgroup/memory.max')
    expect(helper).toContain('/sys/fs/cgroup/cpu.max')
    expect(helper).toContain('Math.max(0.1')
    expect(helper).toContain('memory.rss')
  })


  test("progression stats endpoint is read-only for poll-derived real active averages", () => {
    const route = read("app/api/connections/progression/[id]/stats/route.ts")
    const snapshotBlock = route.slice(
      route.indexOf("Active validated Real positions snapshot"),
      route.indexOf("Live-stage OPEN positions", route.indexOf("Active validated Real positions snapshot")),
    )

    expect(snapshotBlock).toContain("/stats is a GET/read endpoint and must not mutate Redis")
    expect(snapshotBlock).toContain("const existingRealActiveAvg = n(progHash.real_active_pos_avg)")
    expect(snapshotBlock).not.toContain("hincrby")
    expect(snapshotBlock).not.toContain("hset")
  })

  test("dashboard stats polling ignores stale overlapping responses", () => {
    const quickstart = read("components/dashboard/quickstart-section.tsx")
    const overview = read("components/dashboard/statistics-overview-v2.tsx")

    expect(quickstart).toContain("const statsFetchSeqRef = useRef(0)")
    expect(quickstart).toContain("const requestSeq = ++statsFetchSeqRef.current")
    expect(quickstart).toContain("requestSeq !== statsFetchSeqRef.current")

    expect(overview).toContain("const statsFetchSeqRef = useRef(0)")
    expect(overview).toContain("const requestSeq = ++statsFetchSeqRef.current")
    expect(overview).toContain("requestSeq !== statsFetchSeqRef.current")
  })


  test("QuickStart live button uses effective live state and live-trade enable makes engine eligible", () => {
    const quickstart = read("components/dashboard/quickstart-section.tsx")
    const liveRoute = read("app/api/settings/connections/[id]/live-trade/route.ts")
    const helper = read("lib/system-resource-metrics.ts")

    const quickstartHelper = quickstart.slice(
      quickstart.indexOf("QuickStart's Live button controls effective exchange order placement"),
      quickstart.indexOf("// ─── types", quickstart.indexOf("QuickStart's Live button controls effective exchange order placement")),
    )
    expect(quickstartHelper).toContain("toBooleanFlag(conn?.is_live_trade)")
    expect(quickstartHelper).not.toContain("live_trade_requested) ||")
    expect(quickstart).toContain("setLiveTradeActive(effectiveState)")

    const liveEnableBlock = liveRoute.slice(
      liveRoute.indexOf("If Live is turned on while the main engine is not already running"),
      liveRoute.indexOf('live_trade_requested: "1"', liveRoute.indexOf("If Live is turned on while the main engine is not already running")) + 40,
    )
    expect(liveEnableBlock).toContain('is_assigned: "1"')
    expect(liveEnableBlock).toContain('is_enabled_dashboard: "1"')
    expect(liveEnableBlock).toContain('is_active: "1"')
    expect(helper).toContain('os.totalmem')
    expect(helper).toContain('memory.rss')
  })

  test("Redis migrations remain sequential for production schema upgrades", () => {
    const source = read("lib/redis-migrations.ts")
    const versions = Array.from(source.matchAll(/version:\s*(\d+)/g), (match) => Number(match[1]))
    const gaps: Array<[number, number]> = []
    for (let i = 1; i < versions.length; i++) {
      if (versions[i] !== versions[i - 1] + 1) gaps.push([versions[i - 1], versions[i]])
    }

    expect(gaps).toEqual([])
    expect(source).toContain('name: "043-reserved-schema-continuity"')
    expect(source).toContain('name: "044-reserved-schema-continuity"')
    expect(source).toContain('name: "065-dev-prod-database-health-metadata"')
    expect(source).toContain("export function getLatestMigrationVersion")
    expect(source).toContain('"system:database:health"')
    expect(source).toContain('migrations_bundle_version: String(finalVersion)')
  })

  test("Redis init rechecks stale global readiness before skipping migrations", () => {
    const source = read("lib/redis-db.ts")
    const globalReadyBlock = source.slice(
      source.indexOf("if (globalForRedis.__redis_fully_connected)"),
      source.indexOf("if (isConnected) return", source.indexOf("if (globalForRedis.__redis_fully_connected)")),
    )

    expect(globalReadyBlock).toContain("getLatestMigrationVersion")
    expect(globalReadyBlock).toContain('redisInstance!.get("_schema_version")')
    expect(globalReadyBlock).toContain("currentVersion < latestVersion")
    expect(globalReadyBlock).toContain("await runMigrations()")
    expect(globalReadyBlock).toContain("Global ready marker is stale")
  })

  test("QuickStart re-entry preserves running progressions instead of forced restarts", () => {
    const quickStart = read("app/api/trade-engine/quick-start/route.ts")
    const coordinator = read("lib/trade-engine.ts")

    expect(quickStart).toContain("quickstartEngineAlreadyRunning")
    expect(quickStart).toContain("quickstart_engine_reused")
    expect(quickStart).toContain("Running engine reused; QuickStart symbols/settings applied without stop/restart")
    expect(quickStart).toContain("Engine already running — QuickStart settings applied without restart")
    expect(quickStart).toContain("config_set_symbols_processed: quickstartEngineAlreadyRunning ? symbols.length : 0")
    expect(quickStart).toContain("coordinator.invalidateSymbolsCacheForConnection(connectionId)")
    expect(quickStart).not.toContain("quickstart_engine_restart")

    expect(coordinator).toContain("FULL_RESTART_ESCALATION_ENABLED = false")
    expect(coordinator).toContain("restart escalation disabled")
  })

  test("QuickStart commits running Redis intent before dispatching engine starts", () => {
    const quickStart = read("app/api/trade-engine/quick-start/route.ts")
    const step4 = quickStart.slice(
      quickStart.indexOf("// Step 4: Start engine"),
      quickStart.indexOf("// Store in global quickstart state"),
    )
    const intentWriteIndex = step4.indexOf('await client.hset("trade_engine:global", {')
    const startAllIndex = step4.indexOf("coordinator.startAll()")
    const targetedStartIndex = step4.indexOf("const engineStarted = await coord.startEngine")

    expect(intentWriteIndex).toBeGreaterThanOrEqual(0)
    expect(intentWriteIndex).toBeLessThan(startAllIndex)
    expect(intentWriteIndex).toBeLessThan(targetedStartIndex)
    expect(step4).toContain('operator_stopped: "0"')
    expect(step4).toContain("updated_at: quickstartGlobalStartedAt")
    expect(step4).toContain("const quickstartGlobalStartedAt = new Date().toISOString()")

    const intentBlock = step4.slice(intentWriteIndex, step4.indexOf("})", intentWriteIndex))
    expect(intentBlock).toContain('status: "running"')
    expect(intentBlock).toContain('desired_status: "running"')
    expect(intentBlock).toContain('operator_intent: "running"')

    const targetedStartBlock = step4.slice(targetedStartIndex)
    expect(targetedStartBlock).toContain("if (!engineStarted)")
    expect(targetedStartBlock).toContain('"engine_start_skipped"')
    expect(targetedStartBlock).toContain('phase: "queued"')
    expect(targetedStartBlock).toContain('status: "skipped_queued"')
  })

  test("Real-stage evaluation denominator includes related outputs and never reports negative failures", () => {
    const source = read("lib/strategy-coordinator.ts")

    expect(source).toContain("const realRelatedCreated = Math.max(0, realSets.length - mainPFEligible)")
    expect(source).toContain("const realTotalEvaluated = mainPFEligible + realRelatedCreated")
    expect(source).toContain("const passRatioReal = realTotalEvaluated > 0 ? n / realTotalEvaluated : 0")
    expect(source).toContain("evaluated:          String(realEvaluatedAfterFanOut)")
    expect(source).toContain("[`s:${symbol}:evaluated`]:  String(realTotalEvaluated)")
    expect(source).toContain('client.set(`strategies:${this.connectionId}:real:evaluated`, String(realTotalEvaluated))')
    expect(source).toContain("totalCreated: realTotalEvaluated")
    expect(source).toContain("failedEvaluation: Math.max(0, realTotalEvaluated - realSets.length)")
    expect(source).not.toContain("failedEvaluation: mainPFEligible - realSets.length")

    const mainPFEligible = 3
    const realSetsLength = 5
    const realRelatedCreated = Math.max(0, realSetsLength - mainPFEligible)
    const realTotalEvaluated = mainPFEligible + realRelatedCreated

    expect(Math.max(0, realTotalEvaluated - realSetsLength)).toBe(0)
    expect(realTotalEvaluated).toBe(5)
  })

  test("production cron route uses canonical ind-strat pipeline for all configured symbols", () => {
    const cron = read("app/api/cron/generate-indications/route.ts")
    const pipeline = read("lib/trade-engine/shared-ind-strat-pipeline.ts")
    const strategy = read("lib/trade-engine/strategy-processor.ts")

    expect(cron).toContain('runIndStratCycle(connectionId, symbol, "realtime"')
    expect(cron).toContain("new IndicationProcessor(connection.id)")
    expect(cron).toContain("new RealtimeProcessor(connection.id)")
    expect(cron).toContain("new StrategyProcessor(connection.id)")
    expect(cron).toContain("new IndicationSetsProcessor(connection.id)")
    expect(cron).toContain("ensureCurrentMarketDataCandle(symbol, client)")
    expect(cron).toContain("const symbolConcurrency = parsePositiveInteger(process.env.CRON_SYMBOL_CONCURRENCY, 4)")
    expect(cron).toContain("const symbolLimit = parsePositiveInteger(process.env.CRON_SYMBOL_LIMIT, 20)")
    expect(cron).toContain("symbolsToProcess,")
    expect(cron).not.toContain("executeStrategyFlowBatch(strategyItems.slice(0, 2)")
    expect(cron).not.toContain("strategyItems.slice(0, 2)")
    expect(cron).toContain("skipLiveDispatch: process.env.CRON_LIVE_DISPATCH")
    expect(cron).toContain("enableStrategyFlow: process.env.DISABLE_CRON_STRATEGIES !== \"1\"")

    const pseudoIdx = pipeline.indexOf("updateOpenPseudoPositionsForSymbol(symbol)")
    const strategyIdx = pipeline.lastIndexOf("processStrategy(symbol, indications")
    expect(pseudoIdx).toBeGreaterThan(0)
    expect(strategyIdx).toBeGreaterThan(pseudoIdx)
    expect(pipeline).toContain("deps.enableStrategyFlow === true")
    expect(strategy).toContain("skipLiveDispatch: boolean = false")
    expect(strategy).toContain("executeStrategyFlow(symbol, validIndications, false, undefined, skipLiveDispatch)")
  })


  test("trailing coordination survives Main cache and accumulated live sync", () => {
    const coordinator = read("lib/strategy-coordinator.ts")
    const liveStage = read("lib/trade-engine/stages/live-stage.ts")

    expect(coordinator).toContain("trailingProfile: built.trailingProfile")
    expect(coordinator).toContain("Preserve it on")
    expect(coordinator).toContain("every Main projection")
    expect(coordinator).toContain("mutable cache patch")
    expect(coordinator).toContain("...(baseSet.trailingProfile && { trailingProfile: baseSet.trailingProfile })")

    expect(liveStage).toContain("setKey/parentSetKey/accumulatedSetKeys")
    expect(liveStage).toContain("every owning Set must be allowed")
    expect(liveStage).toContain("advance its trailing ratchet")
    expect(liveStage).toContain("const liveKeys = new Set<string>()")
    expect(liveStage).toContain("Array.isArray(p.accumulatedSetKeys)")
    expect(liveStage).toContain("liveKeys.has(pseudoSetKey)")
  })


  test("dashboard footer shows session instance and running time", () => {
    const source = read("components/dashboard/dashboard.tsx")

    expect(source).toContain("function DashboardRuntimeFooter()")
    expect(source).toContain("Unique Session / Instance ID")
    expect(source).toContain("createSessionInstanceId")
    expect(source).toContain("Running: {formatDuration")
    expect(source).toContain("<DashboardRuntimeFooter />")
  })

})
