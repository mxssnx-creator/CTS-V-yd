import fs from "fs"
import path from "path"

const repo = path.resolve(__dirname, "../..")
const read = (file: string) => fs.readFileSync(path.join(repo, file), "utf8")

describe("requested regression guardrails", () => {
  test("live-trade enable clears stale block reason", () => {
    const source = read("app/api/settings/connections/[id]/live-trade/route.ts")
    expect(source).toContain('...(isLiveTrade ? { live_trade_blocked_reason: "" } : {})')
  })

  test("global start clears stale live block reason whenever it enables live trade", () => {
    const source = read("app/api/trade-engine/start/route.ts")
    const liveEnableWrites = source.match(/is_live_trade:\s*"1"/g) || []
    const clearReasonWrites = source.match(/live_trade_blocked_reason:\s*""/g) || []

    expect(liveEnableWrites.length).toBeGreaterThanOrEqual(2)
    expect(clearReasonWrites.length).toBeGreaterThanOrEqual(liveEnableWrites.length)
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
})
