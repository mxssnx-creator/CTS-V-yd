const createExchangeConnectorMock = jest.fn(async () => ({
  testConnection: jest.fn(async () => ({ success: true, balance: 0, logs: [] })),
}))

jest.mock("@/lib/exchange-connectors", () => ({
  createExchangeConnector: (...args: unknown[]) => createExchangeConnectorMock(...args),
}))

jest.mock("@/lib/redis-db", () => ({
  initRedis: jest.fn(async () => undefined),
  getAllConnections: jest.fn(async () => []),
  getConnection: jest.fn(async () => null),
}))

describe("ConnectionCoordinator", () => {
  beforeEach(() => {
    jest.resetModules()
    createExchangeConnectorMock.mockClear()
  })

  test('testConnection treats is_testnet "0" as false when creating the connector', async () => {
    const { ConnectionCoordinator } = await import("@/lib/connection-coordinator")
    const coordinator = ConnectionCoordinator.getInstance() as any

    coordinator.initialized = true
    coordinator.connections = new Map([
      [
        "conn-1",
        {
          id: "conn-1",
          name: "BingX mainnet",
          exchange: "bingx",
          api_key: "real-api-key-123456",
          api_secret: "real-api-secret-123456",
          api_type: "perpetual_futures",
          contract_type: "linear",
          is_testnet: "0",
          is_inserted: "1",
          is_active_inserted: "1",
          is_enabled_dashboard: "1",
        },
      ],
    ])
    coordinator.metrics = new Map()
    coordinator.health = new Map()

    const result = await coordinator.testConnection("conn-1")

    expect(result.success).toBe(true)
    expect(createExchangeConnectorMock).toHaveBeenCalledWith(
      "bingx",
      expect.objectContaining({ isTestnet: false }),
    )
  })
})
