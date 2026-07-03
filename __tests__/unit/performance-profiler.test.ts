import { PerformanceProfiler } from "@/lib/performance-profiler"

describe("PerformanceProfiler", () => {
  afterEach(() => {
    jest.restoreAllMocks()
  })

  it("tracks cycles independently when they start in the same millisecond", () => {
    jest.spyOn(Date, "now").mockReturnValue(1_700_000_000_000)

    const profiler = new PerformanceProfiler()
    const firstCycleId = profiler.startCycle("conn-1", "realtime", "BTCUSDT")
    const secondCycleId = profiler.startCycle("conn-1", "realtime", "BTCUSDT")

    expect(firstCycleId).not.toBe(secondCycleId)

    profiler.recordOperation(firstCycleId, "first-cycle-op")
    profiler.recordOperation(secondCycleId, "second-cycle-op")

    expect(profiler.endCycle(firstCycleId)?.operations.map((op) => op.name)).toEqual(["first-cycle-op"])
    expect(profiler.endCycle(secondCycleId)?.operations.map((op) => op.name)).toEqual(["second-cycle-op"])

    expect(profiler.getStats().operationBreakdown).toEqual(
      expect.objectContaining({
        "first-cycle-op": expect.objectContaining({ count: 1 }),
        "second-cycle-op": expect.objectContaining({ count: 1 }),
      }),
    )
  })
})
