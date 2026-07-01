import { StrategySetsProcessor, MAX_INPUT_MULTIPLIER } from "@/lib/strategy-sets-processor"
import { loadCompactionConfig } from "@/lib/sets-compaction"
import { setSettings } from "@/lib/redis-db"

const store = new Map<string, string>()
const redisStore = new Map<string, unknown>()
const clientStore = new Map<string, string>()

const getMock = jest.fn(async (key: string) => clientStore.get(key) ?? null)
const setMock = jest.fn(async (key: string, value: string) => {
  clientStore.set(key, value)
  return "OK"
})

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
    get: getMock,
    set: setMock,
  })),
  getSettings: jest.fn(async (key: string) => {
    if (key === "strategy_sets_config") {
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    return redisStore.get(key) ?? null
  }),
  setSettings: jest.fn(async (key: string, value: unknown) => {
    redisStore.set(key, value)
  }),
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
describe("StrategySetsProcessor", () => {
  beforeEach(() => {
    jest.clearAllMocks()
    redisStore.clear()
    clientStore.clear()
  })

  test("awaits constructor-loaded non-default settings before processing candidates", async () => {
    redisStore.set("strategy_sets_config", {
      base: 300,
      main: 301,
      real: 302,
      live: 303,
    })

    const { StrategySetsProcessor } = await import("@/lib/strategy-sets-processor")

    const indications = Array.from({ length: 400 }, (_, index) => ({
      type: `indication-${index}`,
      confidence: 0.9,
      profitFactor: 1 + index / 100,
      metadata: { index },
    }))

    const processor = new StrategySetsProcessor("conn-strategy-settings")
    await processor.processAllStrategySets("BTC-USDT", indications)

    const baseEntries = JSON.parse(
      clientStore.get("strategy_set:conn-strategy-settings:BTC-USDT:base") ?? "[]",
    )
    const mainEntries = JSON.parse(
      clientStore.get("strategy_set:conn-strategy-settings:BTC-USDT:main") ?? "[]",
    )

    expect(baseEntries).toHaveLength(300)
    expect(mainEntries).toHaveLength(301)
    expect(Math.min(...baseEntries.map((entry: any) => entry.profitFactor))).toBeCloseTo(1.9)
    expect(Math.min(...mainEntries.map((entry: any) => entry.profitFactor))).toBeCloseTo(1.99)
  })
})
