/**
 * Regression coverage for save-while-running settings propagation.
 *
 * Scenario: an operator saves a Main Connection PF threshold while the engine
 * is running. The PATCH handler persists the new flat threshold and calls the
 * settings recoordinator; this test covers the durable signal contract that
 * makes the engine-owning process consume the new threshold on the next (or
 * immediate) strategy cycle and lets the UI refresh without manual stop/start.
 */

const writes: Array<{ key: string; value: unknown }> = []
const hsets: Array<{ key: string; value: unknown }> = []
const store = new Map<string, unknown>()

jest.mock("@/lib/redis-db", () => ({
  initRedis: jest.fn(async () => undefined),
  getConnection: jest.fn(async () => null),
  getSettings: jest.fn(async (key: string) => store.get(key) ?? null),
  setSettings: jest.fn(async (key: string, value: unknown) => {
    writes.push({ key, value })
    store.set(key, value)
  }),
  getRedisClient: jest.fn(() => ({
    hset: jest.fn(async (key: string, value: unknown) => {
      hsets.push({ key, value })
      return 1
    }),
    hdel: jest.fn(async () => 1),
  })),
}))

describe("settings propagation", () => {
  beforeEach(() => {
    writes.length = 0
    hsets.length = 0
    store.clear()
    store.set("trade_engine_state:conn-main", { status: "running" })
  })

  test("PF-only PATCH changes persist dirty flag and reload envelope before success", async () => {
    const { notifySettingsChanged } = await import("@/lib/settings-coordinator")

    await notifySettingsChanged(
      "conn-main",
      ["strategies", "mainProfitFactor", "connection_settings"],
      { connection_settings: { strategies: { main: { main: { min_profit_factor: 1.2 } } } } },
      { connection_settings: { strategies: { main: { main: { min_profit_factor: 1.8 } } } } },
    )

    expect(writes.map((w) => w.key)).toEqual(
      expect.arrayContaining([
        "settings_change:conn-main",
        "settings:dirty:conn-main",
        "settings_change_counter:conn-main",
        "trade_engine_state:conn-main",
      ]),
    )
    expect(writes.find((w) => w.key === "settings:dirty:conn-main")?.value).toBe("1")
    expect(writes.find((w) => w.key === "settings_change:conn-main")?.value).toMatchObject({
      connectionId: "conn-main",
      changeType: "reload",
      changedFields: ["strategies", "mainProfitFactor", "connection_settings"],
    })
    expect(writes.find((w) => w.key === "trade_engine_state:conn-main")?.value).toMatchObject({
      reload_required: true,
      reload_fields: ["strategies", "mainProfitFactor", "connection_settings"],
    })
    expect(hsets.find((w) => w.key === "progression:conn-main")?.value).toHaveProperty("settings_changed_at")
  })

  test("in-process settings event fires after durable reload state is written", async () => {
    const { notifySettingsChanged, onSettingsChanged } = await import("@/lib/settings-coordinator")
    const observed: Array<{ hasReloadState: boolean; pendingExists: boolean }> = []
    const unsubscribe = onSettingsChanged("conn-main", () => {
      observed.push({
        hasReloadState: writes.some(
          (w) => w.key === "trade_engine_state:conn-main" && (w.value as any)?.reload_required === true,
        ),
        pendingExists: writes.some((w) => w.key === "settings_change:conn-main"),
      })
    })

    try {
      await notifySettingsChanged("conn-main", ["strategies"])
      await Promise.resolve()
    } finally {
      unsubscribe()
    }

    expect(observed).toEqual([{ hasReloadState: true, pendingExists: true }])
  })

  test("in-process settings event handler failures do not fail durable settings save", async () => {
    const { notifySettingsChanged, onSettingsChanged } = await import("@/lib/settings-coordinator")
    const unsubscribe = onSettingsChanged("conn-main", () => {
      throw new Error("subscriber failed")
    })

    try {
      await expect(notifySettingsChanged("conn-main", ["strategies"])).resolves.toMatchObject({
        connectionId: "conn-main",
        changeType: "reload",
      })
    } finally {
      unsubscribe()
    }

    expect(writes.some((w) => w.key === "settings_change:conn-main")).toBe(true)
    expect(writes.some((w) => w.key === "trade_engine_state:conn-main")).toBe(true)
  })
})

describe("System tab capacity controls", () => {
  test("exposes capacity and stage controls using canonical settings keys", () => {
    const fs = require("fs")
    const path = require("path")
    const source = fs.readFileSync(
      path.join(process.cwd(), "components/settings/tabs/system-tab.tsx"),
      "utf8",
    )

    expect(source).toContain("Capacity & Stage Limits")
    for (const key of [
      "symbolOrderType",
      "numberOfSymbolsToSelect",
      "mainSymbols",
      "forcedSymbols",
      "setCompactionFloor",
      "setCompactionThresholdPct",
      "setCompactionByType",
      "indication.direction",
      "indication.move",
      "indication.active",
      "indication.optimal",
      "indication.active_advanced",
      "strategy.base",
      "strategy.main",
      "strategy.real",
      "strategy.live",
      "indicationTimeoutMs",
      "indication_state_retention_hours",
      "maxRealSets",
      "stageMinPosCountBase",
      "stageMinPosCountMain",
      "stageMinPosCountReal",
      "baseProfitFactor",
      "mainProfitFactor",
      "realProfitFactor",
      "liveProfitFactor",
      "maxDrawdownTimeMainHours",
      "maxDrawdownTimeRealHours",
      "maxDrawdownTimeLiveHours",
    ]) {
      expect(source).toContain(key)
    }

    expect(source).not.toContain('handleSettingChange("symbolCount"')
    expect(source).not.toContain('handleSettingChange("capacity')
  })
})
