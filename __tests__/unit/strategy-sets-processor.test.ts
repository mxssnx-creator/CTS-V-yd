import { StrategySetsProcessor, MAX_INPUT_MULTIPLIER } from "@/lib/strategy-sets-processor"
import { loadCompactionConfig } from "@/lib/sets-compaction"
import { setSettings } from "@/lib/redis-db"

const store = new Map<string, string>()

jest.mock("@/lib/redis-db", () => ({
  initRedis: jest.fn(async () => undefined),
  getRedisClient: jest.fn(() => ({
    get: jest.fn(async (key: string) => store.get(key) ?? null),
    set: jest.fn(async (key: string, value: string) => {
      store.set(key, value)
      return "OK"
    }),
  })),
  getSettings: jest.fn(async () => null),
  setSettings: jest.fn(async () => undefined),
}))

jest.mock("@/lib/engine-progression-logs", () => ({
  logProgressionEvent: jest.fn(async () => undefined),
}))

jest.mock("@/lib/broadcast-helpers", () => ({
  emitStrategyUpdate: jest.fn(),
}))

jest.mock("@/lib/sets-compaction", () => {
  const actual = jest.requireActual("@/lib/sets-compaction")
  return {
    ...actual,
    loadCompactionConfig: jest.fn(async (type: string) =>
      type === "strategy.base"
        ? { floor: 5000, thresholdPct: 20 }
        : { floor: 250, thresholdPct: 20 },
    ),
  }
})

describe("StrategySetsProcessor", () => {
  beforeEach(() => {
    store.clear()
    jest.clearAllMocks()
  })

  test("uses resolved compaction floors when selecting top strategy candidates", async () => {
    const processor = new StrategySetsProcessor("conn-1")
    const candidateCount = 5000 * MAX_INPUT_MULTIPLIER + 25
    const indications = Array.from({ length: candidateCount }, (_, i) => ({
      type: "mock",
      confidence: 0.9,
      profitFactor: 2 + i / candidateCount,
      metadata: {},
    }))

    await processor.processAllStrategySets("BTCUSDT", indications)

    expect(loadCompactionConfig).toHaveBeenCalledWith("strategy.base")
    expect(setSettings).toHaveBeenCalledWith(
      "strategy_set:conn-1:BTCUSDT:base:stats",
      expect.objectContaining({
        totalCalculated: expect.any(Number),
      }),
    )
    const baseStatsCall = (setSettings as jest.Mock).mock.calls.find(
      ([key]) => key === "strategy_set:conn-1:BTCUSDT:base:stats",
    )
    expect(baseStatsCall?.[1].totalCalculated).toBeGreaterThanOrEqual(5000 * MAX_INPUT_MULTIPLIER)
  })
})
