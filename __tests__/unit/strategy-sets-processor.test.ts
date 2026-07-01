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
