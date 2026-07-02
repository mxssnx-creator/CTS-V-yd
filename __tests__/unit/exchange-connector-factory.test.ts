import { ExchangeConnectorFactory, createExchangeConnector } from "@/lib/exchange-connectors/factory"
import type { Connection } from "@/lib/db-types"

jest.mock("@/lib/exchange-connectors/index", () => ({
  createExchangeConnector: jest.fn(async (_exchange: string, credentials: unknown) => ({
    credentials,
  })),
}))

const createExchangeConnectorMock = jest.mocked(createExchangeConnector)

function buildConnection(isTestnet: unknown): Connection {
  return {
    id: `conn-${String(isTestnet)}`,
    exchange: "simulated",
    api_key: "api-key",
    api_secret: "api-secret",
    is_testnet: isTestnet,
  } as Connection
}

describe("ExchangeConnectorFactory.createConnector", () => {
  beforeEach(() => {
    jest.clearAllMocks()
    ExchangeConnectorFactory.getInstance().clearAll()
  })

  test.each([
    ["0", false],
    ["1", true],
    [false, false],
    [true, true],
  ])("maps is_testnet %p to credentials.isTestnet %p", async (isTestnet, expected) => {
    await ExchangeConnectorFactory.getInstance().createConnector(buildConnection(isTestnet))

    expect(createExchangeConnectorMock).toHaveBeenCalledTimes(1)
    expect(createExchangeConnectorMock.mock.calls[0]?.[1]).toMatchObject({
      isTestnet: expected,
    })
  })
})
