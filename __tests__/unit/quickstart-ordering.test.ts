describe("QuickStart route ordering", () => {
  afterEach(() => {
    jest.resetModules()
    jest.clearAllMocks()
  })

  test("commits running intent before startEngine can check global coordinator state", async () => {
    const callOrder: string[] = []
    const globalIntent: Record<string, string> = {}

    const redisClient = {
      hset: jest.fn(async (key: string, value: Record<string, string>) => {
        if (key === "trade_engine:global") {
          callOrder.push("hset:trade_engine:global")
          Object.assign(globalIntent, value)
        }
        return 1
      }),
      hgetall: jest.fn(async (key: string) => key === "trade_engine:global" ? globalIntent : {}),
      hdel: jest.fn(async () => 0),
      del: jest.fn(async () => 0),
      expire: jest.fn(async () => 1),
      set: jest.fn(async () => "OK"),
      get: jest.fn(async () => null),
      scard: jest.fn(async () => 0),
    }

    const startEngine = jest.fn(async () => {
      callOrder.push(`startEngine:${globalIntent.operator_intent}:${globalIntent.operator_stopped}`)
      return false
    })
    const startAll = jest.fn(async () => {
      callOrder.push(`startAll:${globalIntent.operator_intent}:${globalIntent.operator_stopped}`)
    })

    jest.doMock("@/lib/redis-db", () => ({
      initRedis: jest.fn(async () => undefined),
      getRedisClient: jest.fn(() => redisClient),
      getAllConnections: jest.fn(async () => [{
        id: "conn-1",
        name: "Simulated BingX",
        exchange: "bingx",
        connector_type: "simulated",
        exchange_type: "simulated",
        api_key: "",
        api_secret: "",
      }]),
      updateConnection: jest.fn(async () => undefined),
      setSettings: jest.fn(async () => undefined),
      getSettings: jest.fn(async () => ({})),
      buildMainConnectionEnableUpdate: jest.fn((connection: any) => connection),
    }))
    jest.doMock("@/lib/system-version", () => ({ API_VERSIONS: { tradeEngine: "test" } }))
    jest.doMock("@/lib/engine-progression-logs", () => ({
      logProgressionEvent: jest.fn(async () => undefined),
      getProgressionLogs: jest.fn(async () => []),
    }))
    jest.doMock("@/lib/exchange-connectors", () => ({
      createExchangeConnector: jest.fn(),
    }))
    jest.doMock("@/lib/trade-engine", () => ({
      getGlobalTradeEngineCoordinator: jest.fn(() => ({
        isEngineRunning: jest.fn(() => false),
        invalidateSymbolsCacheForConnection: jest.fn(),
        applyPendingChangesNow: jest.fn(async () => undefined),
        startAll,
        startEngine,
        refreshEngines: jest.fn(async () => undefined),
      })),
    }))
    jest.doMock("@/lib/settings-storage", () => ({
      loadSettingsAsync: jest.fn(async () => ({
        mainEngineIntervalMs: 5000,
        strategyUpdateIntervalMs: 10000,
        realtimeIntervalMs: 300,
      })),
    }))
    jest.doMock("@/lib/top-symbols", () => ({
      fetchTopSymbols: jest.fn(),
      normaliseSort: jest.fn(() => "volatility_1h"),
    }))

    const { POST } = await import("@/app/api/trade-engine/quick-start/route")
    const response = await POST(new Request("http://localhost/api/trade-engine/quick-start", {
      method: "POST",
      body: JSON.stringify({
        action: "enable",
        connectionId: "conn-1",
        symbols: ["DRIFTUSDT"],
        liveTrade: false,
      }),
    }))

    expect(response.status).toBe(200)
    await new Promise<void>((resolve) => setImmediate(resolve))

    expect(redisClient.hset).toHaveBeenCalledWith("trade_engine:global", expect.objectContaining({
      status: "running",
      desired_status: "running",
      operator_intent: "running",
      operator_stopped: "0",
      updated_at: expect.any(String),
    }))
    expect(startAll).toHaveBeenCalled()
    expect(startEngine).toHaveBeenCalled()
    expect(callOrder.indexOf("hset:trade_engine:global")).toBeLessThan(callOrder.findIndex((entry) => entry.startsWith("startAll:")))
    expect(callOrder.indexOf("hset:trade_engine:global")).toBeLessThan(callOrder.findIndex((entry) => entry.startsWith("startEngine:")))
    expect(callOrder).toContain("startEngine:running:0")
  })
})
