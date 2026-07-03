import fs from "fs"
import path from "path"

const repo = path.resolve(__dirname, "../..")
const read = (file: string) => fs.readFileSync(path.join(repo, file), "utf8")

describe("GlobalTradeEngineCoordinator.startEngine lock contention", () => {
  test("fresh owner heartbeat leaves duplicate start untouched", () => {
    const source = read("lib/trade-engine.ts")
    const failedAcquireBranch = source.slice(
      source.indexOf("if (!acquired.acquired || !acquired.handle)"),
      source.indexOf("lockHandle = acquired.handle"),
    )
    const freshOwnerBranch = failedAcquireBranch.slice(
      failedAcquireBranch.indexOf("if (ownerHeartbeatFresh)"),
      failedAcquireBranch.indexOf("with a stale heartbeat"),
    )
    const staleOwnerBranch = failedAcquireBranch.slice(
      failedAcquireBranch.indexOf("with a stale heartbeat"),
    )

    expect(failedAcquireBranch).toContain("trade_engine_state:${connectionId}")
    expect(failedAcquireBranch).toContain("last_processor_heartbeat")
    expect(failedAcquireBranch).toContain("Date.now() - ownerHeartbeat < ownerHeartbeatFreshnessMs")
    expect(failedAcquireBranch).toContain("const ownerHeartbeatFreshnessMs = 90_000")

    expect(freshOwnerBranch).toContain("return true")
    expect(freshOwnerBranch).not.toContain("forceBreakProgressionLock")
    expect(freshOwnerBranch).not.toContain("stopEngine(connectionId)")
    expect(freshOwnerBranch).not.toContain("stop_requested")

    expect(staleOwnerBranch).toContain("client.hset(`trade_engine_state:${connectionId}`")
    expect(staleOwnerBranch).toContain("client.hset(`progression:${connectionId}`")
    expect(staleOwnerBranch).toContain("stop_requested")
    expect(staleOwnerBranch).toContain("await this.stopEngine(connectionId)")
    expect(staleOwnerBranch).toContain("await forceBreakProgressionLock(connectionId)")
  })
  test("runtime gate allows explicit foreground starts only when safe", () => {
    const source = read("lib/trade-engine.ts")
    const startEngine = source.slice(
      source.indexOf("async startEngine(connectionId: string"),
      source.indexOf("// Self-heal background timers"),
    )

    expect(startEngine).toContain("const forceLocalTakeover = options.forceLocalTakeover === true || config.allowInProcessStart === true")
    expect(startEngine).toContain('process.env.DISABLE_TRADE_ENGINE_IN_PROCESS === "1" || process.env.NEXT_RUNTIME === "edge"')
    expect(startEngine).toContain('process.env.VERCEL === "1" && !explicitForegroundAllowed')
    expect(startEngine).toContain("Vercel serverless workers are queued-only without explicit foreground worker flags")
    expect(startEngine).toContain("if (!forceLocalTakeover && !this.canOwnEngineRuntime())")
    expect(startEngine).toContain("queued-only in this production API worker")
  })

  test("dev and explicit long-lived node start paths are not blocked by the queued-only production gate", () => {
    const source = read("lib/trade-engine.ts")
    const canOwn = source.slice(
      source.indexOf("private canOwnEngineRuntime(): boolean"),
      source.indexOf("constructor()"),
    )
    const startEngine = source.slice(
      source.indexOf("async startEngine(connectionId: string"),
      source.indexOf("// Self-heal background timers"),
    )

    expect(canOwn).toContain('process.env.NODE_ENV !== "production"')
    expect(canOwn).toContain('process.env.ALLOW_API_TRADE_ENGINE_FOREGROUND === "1"')
    expect(canOwn).toContain('process.env.ENABLE_TRADE_ENGINE_IN_PROCESS === "1"')
    expect(startEngine).toContain("config.allowInProcessStart === true")
    expect(startEngine).toContain("options.forceLocalTakeover === true")
    expect(startEngine).toContain("!forceLocalTakeover && !this.canOwnEngineRuntime()")
  })

  test("QuickStart and start-all only report engine starts when startEngine returns true", () => {
    const quickStart = read("app/api/trade-engine/quick-start/route.ts")
    const startAll = read("app/api/trade-engine/start-all/route.ts")

    expect(quickStart).toContain("const engineStarted = await coord.startEngine")
    expect(quickStart).toContain("if (!engineStarted)")
    expect(quickStart).toContain("engine_start_skipped")
    expect(quickStart.indexOf("if (!engineStarted)")).toBeLessThan(quickStart.indexOf("Main Engine started for"))

    expect(startAll).toContain("const engineStarted = await coordinator.startEngine")
    expect(startAll).toContain("success: engineStarted")
    expect(startAll).toContain('message: engineStarted ? "Engine started" : "Engine start skipped by coordinator"')
    expect(startAll).toContain("if (engineStarted)")
  })

})
