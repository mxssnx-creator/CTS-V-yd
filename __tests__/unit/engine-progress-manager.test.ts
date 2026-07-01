import { EngineProgressManager } from "@/lib/engine-progress-manager"

describe("EngineProgressManager", () => {
  afterEach(() => {
    jest.restoreAllMocks()
  })

  test("updateSymbolWS accumulates global message and error totals from per-symbol deltas", async () => {
    jest.spyOn(EngineProgressManager.prototype, "saveState").mockResolvedValue()

    const manager = new EngineProgressManager("test-connection")

    await manager.updateSymbolWS("BTCUSDT", true, 1, 0)
    await manager.updateSymbolWS("BTCUSDT", true, 2, 1)
    await manager.updateSymbolWS("BTCUSDT", true, 3, 1)

    const state = manager.getState()
    expect(state.wsMessagesTotal).toBe(3)
    expect(state.wsErrorsTotal).toBe(1)
    expect(state.wsMessagesTotal).not.toBe(6)
    expect(state.wsErrorsTotal).not.toBe(2)
  })
})
