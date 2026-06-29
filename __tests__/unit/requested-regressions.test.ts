import fs from "fs"
import path from "path"

const repo = path.resolve(__dirname, "../..")
const read = (file: string) => fs.readFileSync(path.join(repo, file), "utf8")

describe("requested regression guardrails", () => {
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

  test("startEngine retries stale cross-worker startup locks", () => {
    const source = read("lib/trade-engine.ts")
    const lockBranch = source.slice(
      source.indexOf("Cannot start engine ${connectionId}"),
      source.indexOf("lockHandle = acquired.handle"),
    )

    expect(lockBranch).toContain("forceBreakProgressionLock")
    expect(lockBranch).not.toMatch(/return false\s+try/)
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

  test("standard and position-count sets are ordered before adjust variants", () => {
    const source = read("lib/strategy-coordinator.ts")

    expect(source).toContain("Operator rule: process the Standard strategy outputs first")
    expect(source).toContain("const mainSetOrder = (set: StrategySet): number")
    expect(source).toContain('if (set.variant === "block") return 3')
    expect(source).toContain('if (set.variant === "dca") return 4')
    expect(source).toContain("mainSets.sort((a, b) => mainSetOrder(a) - mainSetOrder(b))")
  })

  test("production strategy fan-out has env-overridable liveness ceilings", () => {
    const source = read("lib/strategy-coordinator.ts")

    expect(source).toContain("STRATEGY_MAIN_AXIS_SETS_CEILING")
    expect(source).toContain(": 50")
    expect(source).toContain("STRATEGY_REAL_SETS_SAFETY_CEILING")
    expect(source).toContain(": 100")
    expect(source).toContain("private static readonly _AXIS_LRU_MAX = 8_000")
  })

  test("production web boot does not auto-start heavy engine loops unless explicitly opted in", () => {
    const instrumentation = read("instrumentation.ts")
    const continuityRunner = read("lib/server-continuity-runner.ts")

    expect(instrumentation).toContain('ENABLE_TRADE_ENGINE_AUTOSTART === "1"')
    expect(instrumentation).toContain("trade-engine auto-start skipped")
    expect(instrumentation).toContain('ENABLE_IN_PROCESS_CONTINUITY === "1"')
    expect(continuityRunner).toContain('ENABLE_IN_PROCESS_CONTINUITY !== "1"')
    expect(continuityRunner).toContain("web/UI process")
  })

  test("status route does not report stale Redis running intent as local engine progress", () => {
    const source = read("app/api/trade-engine/status/route.ts")

    expect(source).toContain("const coordinatorEngineCount = coordinator?.getActiveEngineCount() || 0")
    expect(source).toContain("const hasLocalEngineRuntime = coordinatorEngineCount > 0")
    expect(source).toContain("connectionRunning = effectivelyRunning && !isGloballyPaused && hasLocalEngineRuntime")
    expect(source).toContain("workerAttached: hasLocalEngineRuntime")
    expect(source).toContain("operatorStatus: engineHash.status || \"stopped\"")
    expect(source).toContain("const activeEngineCount = coordinatorEngineCount")
    expect(source).not.toContain("Math.max(coordinatorEngineCount, summary.running)")
  })

  test("settings save does not auto-start heavy engine loops in an unopted web worker", () => {
    const source = read("lib/connection-recoordinator.ts")

    expect(source).toContain('process.env.ENABLE_TRADE_ENGINE_AUTOSTART === "1" || coordinator.isRunning()')
    expect(source).toContain("web worker has no local engine runtime/opt-in")
    expect(source).toContain("settings apply on next explicit Start or dedicated worker tick")
  })

  test("dashboard enable queues engine start instead of blocking an unopted production UI worker", () => {
    const source = read("app/api/settings/connections/[id]/toggle-dashboard/route.ts")

    expect(source).toContain('process.env.ENABLE_TRADE_ENGINE_AUTOSTART === "1" || coordinator.isRunning()')
    expect(source).toContain("Connection enabled; start queued for coordinator worker")
    expect(source).toContain("this UI worker is not opted in for local engine loops")
    expect(source).toContain('engineStatus = "queued"')
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
})
