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

  test("indication windows use idempotent per-symbol fields", () => {
    const processor = read("lib/indication-sets-processor.ts")
    const cron = read("app/api/cron/generate-indications/route.ts")
    const tracking = read("lib/detailed-tracking.ts")

    expect(processor).toContain("[`${symbol}:move`]: String(moveQ)")
    expect(processor).not.toContain('pipe.hincrby(w5Key,  "move"')
    expect(cron).toContain("pipeline.hset(w5Key,  `${symbol}:${type}`, String(count))")
    expect(cron).toContain("Zeroes are written too")
    expect(tracking).toContain("aggregateWindowByType")
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
})
