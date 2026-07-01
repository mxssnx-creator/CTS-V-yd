import { EngineProgressManager } from "@/lib/engine-progress-manager"

jest.mock("@/lib/redis-db", () => ({
  getRedisClient: jest.fn(() => ({
    get: jest.fn(async () => null),
    set: jest.fn(async () => "OK"),
  })),
  getSettings: jest.fn(async () => null),
  setSettings: jest.fn(async () => undefined),
}))

describe("EngineProgressManager", () => {
  test("updates prehistoric aggregate totals by symbol deltas", async () => {
    const manager = new EngineProgressManager("test-connection")

    await manager.updateSymbolPrehistoric("BTCUSDT", 100, 0, 10, true)
    await manager.updateSymbolPrehistoric("BTCUSDT", 100, 0, 10, true)

    const state = manager.getState()
    expect(state.prehistoricLoadedSymbols).toBe(1)
    expect(state.prehistoricTotalCandles).toBe(100)
  })
})
