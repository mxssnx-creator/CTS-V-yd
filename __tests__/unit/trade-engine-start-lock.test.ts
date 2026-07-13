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

    expect(quickStart).toContain("const started = await coord.startEngine")
    expect(quickStart).toContain("if (!started)")
    expect(quickStart).toContain("engine_start_queued")
    expect(quickStart.indexOf("if (!started)")).toBeLessThan(quickStart.indexOf("Main Engine started for"))

    expect(startAll).toContain("const results = await Promise.all(activeConnections.map(async (connection) =>")
    expect(startAll).toContain("const started = await coordinator.startEngine")
    expect(startAll).toContain("success: started")
    expect(startAll).toContain('message: started ? "Engine started" : "Engine start queued for coordinator worker"')
    expect(startAll).toContain("const successCount = results.filter((result) => result.success).length")
    expect(startAll).toContain('message: `Started ${successCount} of ${activeConnections.length} trade engines`')
    expect(startAll).not.toContain("Engine start dispatched")
  })


  test("queued starts remain durable until a foreground-capable coordinator accepts ownership", () => {
    const source = read("lib/trade-engine.ts")
    const drain = source.slice(
      source.indexOf("public async drainQueuedRefreshRequestsNow"),
      source.indexOf("public invalidateSymbolsCacheForConnection"),
    )
    const startFromConfig = source.slice(
      source.indexOf("private async startEngineFromConnectionConfig"),
      source.indexOf("async toggleEngine"),
    )
    const autoStart = read("lib/trade-engine-auto-start.ts")
    const quickStart = read("app/api/trade-engine/quick-start/route.ts")
    const startAll = read("app/api/trade-engine/start-all/route.ts")

    expect(drain).toContain("const started = await this.startEngineFromConnectionConfig(request.connectionId)")
    expect(drain).toContain("remains queued")
    expect(drain.indexOf("remains queued")).toBeLessThan(drain.indexOf("continue", drain.indexOf("remains queued")))
    expect(drain.indexOf("continue", drain.indexOf("remains queued"))).toBeLessThan(drain.indexOf("await clearEngineRefreshRequest(request.connectionId)", drain.indexOf("remains queued")))
    expect(startFromConfig).toContain("Promise<boolean>")
    expect(startFromConfig).toContain("return await this.startEngine(connectionId, config)")
    expect(startFromConfig).toContain("return false")
    expect(drain).toContain("now - requestTime >= 120_000")
    expect(autoStart).toContain("const startedCount = await coordinator.startMissingEngines([connection])")
    expect(autoStart).toContain("remains queued")
    expect(autoStart).toContain("continue")

    expect(quickStart).toContain("queueEngineRefreshRequest")
    expect(quickStart).toContain('reason: "quickstart_start_skipped"')
    expect(startAll).toContain("queueEngineRefreshRequest")
    expect(startAll).toContain('reason: "start_all_start_skipped"')
    expect(quickStart).toContain("const engineStarted = await coord.startEngine")
    expect(quickStart).toContain("if (!engineStarted)")
    expect(quickStart).toContain("engine_start_skipped")
    expect(quickStart.indexOf("if (!engineStarted)")).toBeLessThan(quickStart.indexOf("Main Engine started for"))

    expect(startAll).toContain("const engineStarted = await coordinator.startEngine")
    expect(startAll).toContain("success: engineStarted")
    expect(startAll).toContain('message: engineStarted ? "Engine started" : "Engine start skipped by coordinator"')
    expect(startAll).toContain("if (engineStarted)")
  })

  test("Global Start queues and reports skipped startEngine calls instead of counting them as started", () => {
    const source = read("app/api/trade-engine/start/route.ts")

    expect(source).toContain('import { currentStateSwitchVersion, queueEngineRefreshRequest } from "@/lib/engine-refresh-queue"')
    expect(source).toContain("const started = await coordinator.startEngine(connId")
    expect(source).toContain("const started = await coordinator.startEngine(conn.id")
    expect(source).toContain('reason: "global_resume_start_skipped"')
    expect(source).toContain('reason: "global_start_skipped"')
    expect(source).toContain("state_switch_version: currentStateSwitchVersion(updatedConn)")
    expect(source).toContain("if (started === true)")
    expect(source).toContain("queuedResumedConnections")
    expect(source).toContain("queuedStartedConnections")
    expect(source).toContain("queuedResumedCount: queuedResumedConnections.length")
    expect(source).toContain("queuedStartedCount: queuedStartedConnections.length")

    const resumeStart = source.slice(
      source.indexOf("const started = await coordinator.startEngine(connId"),
      source.indexOf("// Clear the paused main list"),
    )
    expect(resumeStart.indexOf("if (started === true)")).toBeLessThan(resumeStart.indexOf("resumedConnections.push(connId)"))
    expect(resumeStart.indexOf("if (started === true)")).toBeLessThan(resumeStart.indexOf("queuedResumedConnections.push(connId)"))

    const assignedStart = source.slice(
      source.indexOf("const started = await coordinator.startEngine(conn.id"),
      source.indexOf("// Also resume preset engines"),
    )
    expect(assignedStart.indexOf("if (started === true)")).toBeLessThan(assignedStart.indexOf("startedConnections.push(conn.id)"))
    expect(assignedStart.indexOf("if (started === true)")).toBeLessThan(assignedStart.indexOf("queuedStartedConnections.push(conn.id)"))
  })



  test("queued start requests use action-aware expiry and are not dropped by refresh TTL", () => {
    const queue = read("lib/engine-refresh-queue.ts")
    const coordinator = read("lib/trade-engine.ts")
    const autoStart = read("lib/trade-engine-auto-start.ts")

    expect(queue).toContain("export const REFRESH_REQUEST_MAX_AGE_MS = 30_000")
    expect(queue).toContain("export const START_REQUEST_MAX_AGE_MS = Number.POSITIVE_INFINITY")
    expect(queue).toContain('request.action === "start" ? START_REQUEST_MAX_AGE_MS : REFRESH_REQUEST_MAX_AGE_MS')
    expect(queue).toContain("if (!Number.isFinite(maxAgeMs)) return false")

    expect(coordinator).toContain("isEngineRefreshRequestExpired(request, now)")
    expect(coordinator).not.toContain("now - requestTime >= 30000")
    expect(autoStart).toContain("isEngineRefreshRequestExpired(request)")
    expect(autoStart).not.toContain("Date.now() - requestTime >= 120_000")
  })

})
