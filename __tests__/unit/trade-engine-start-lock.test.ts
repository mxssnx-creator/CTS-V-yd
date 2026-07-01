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
})
