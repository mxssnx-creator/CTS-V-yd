import { jest } from "@jest/globals"

jest.mock("@/lib/redis-migrations", () => ({
  runMigrations: jest.fn(async () => undefined),
  resetMigrationRunState: jest.fn(),
  getLatestMigrationVersion: jest.fn(() => 0),
}))

describe("redis-db secondary indexes", () => {
  const originalEnv = { ...process.env }

  async function loadRedisDb() {
    jest.resetModules()
    process.env = { ...originalEnv, NODE_ENV: "test" }
    delete process.env.REDIS_URL
    delete process.env.KV_URL
    delete process.env.UPSTASH_REDIS_REST_URL
    delete process.env.KV_REST_API_URL
    delete (globalThis as any).__redis_core_promise
    delete (globalThis as any).__redis_init_promise
    delete (globalThis as any).__redis_fully_connected
    delete (globalThis as any).__redis_backend
    delete (globalThis as any).__redis_data
    delete (globalThis as any).__redis_snapshot_loaded

    const redisDb = await import("@/lib/redis-db")
    await redisDb.initRedis()
    await redisDb.getRedisClient().flushDb()
    return redisDb
  }

  afterAll(() => {
    process.env = originalEnv
  })

  it("populates collection and connection indexes when hashes are saved", async () => {
    const redisDb = await loadRedisDb()
    const client = redisDb.getRedisClient()

    await redisDb.savePosition({ id: "pos-1", connection_id: "conn-a", symbol: "BTCUSDT" })
    await redisDb.saveTrade({ id: "trade-1", connectionId: "conn-a", symbol: "ETHUSDT" })
    await redisDb.saveIndication({ id: "ind-1", type: "rsi" })
    await redisDb.saveStrategy({ id: "strat-1", name: "baseline" })

    await expect(client.smembers("idx:positions")).resolves.toEqual(["pos-1"])
    await expect(client.smembers("idx:positions:connection:conn-a")).resolves.toEqual(["pos-1"])
    await expect(client.smembers("idx:trades")).resolves.toEqual(["trade-1"])
    await expect(client.smembers("idx:trades:connection:conn-a")).resolves.toEqual(["trade-1"])
    await expect(client.smembers("idx:indications")).resolves.toEqual(["ind-1"])
    await expect(client.smembers("idx:strategies")).resolves.toEqual(["strat-1"])
  })

  it("uses secondary index sets for collection and connection reads", async () => {
    const redisDb = await loadRedisDb()
    const client = redisDb.getRedisClient()

    await redisDb.savePosition({ id: "pos-1", connection_id: "conn-a", symbol: "BTCUSDT" })
    await redisDb.savePosition({ id: "pos-2", connection_id: "conn-b", symbol: "SOLUSDT" })
    await redisDb.saveTrade({ id: "trade-1", connection_id: "conn-a", symbol: "ETHUSDT" })
    await redisDb.saveIndication({ id: "ind-1", type: "rsi" })
    await redisDb.saveStrategy({ id: "strat-1", name: "baseline" })

    const keysSpy = jest.spyOn(client, "keys")

    await expect(redisDb.getAllPositions()).resolves.toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "pos-1" }),
      expect.objectContaining({ id: "pos-2" }),
    ]))
    await expect(redisDb.getConnectionPositions("conn-a")).resolves.toEqual([
      expect.objectContaining({ id: "pos-1", connection_id: "conn-a" }),
    ])
    await expect(redisDb.getAllTrades()).resolves.toEqual([
      expect.objectContaining({ id: "trade-1" }),
    ])
    await expect(redisDb.getConnectionTrades("conn-a")).resolves.toEqual([
      expect.objectContaining({ id: "trade-1", connection_id: "conn-a" }),
    ])
    await expect(redisDb.getAllIndications()).resolves.toEqual([
      expect.objectContaining({ id: "ind-1" }),
    ])
    await expect(redisDb.getAllStrategies()).resolves.toEqual([
      expect.objectContaining({ id: "strat-1" }),
    ])

    expect(keysSpy).not.toHaveBeenCalled()
  })

  it("cleans secondary indexes when indexed hashes are deleted", async () => {
    const redisDb = await loadRedisDb()
    const client = redisDb.getRedisClient()

    await redisDb.savePosition({ id: "pos-1", connection_id: "conn-a" })
    await redisDb.saveTrade({ id: "trade-1", connection_id: "conn-a" })
    await redisDb.saveIndication({ id: "ind-1" })
    await redisDb.saveStrategy({ id: "strat-1" })

    await redisDb.deletePosition("pos-1")
    await client.del("trade:trade-1", "indication:ind-1", "strategy:strat-1")

    await expect(client.smembers("idx:positions")).resolves.toEqual([])
    await expect(client.smembers("idx:positions:connection:conn-a")).resolves.toEqual([])
    await expect(client.smembers("idx:trades")).resolves.toEqual([])
    await expect(client.smembers("idx:trades:connection:conn-a")).resolves.toEqual([])
    await expect(client.smembers("idx:indications")).resolves.toEqual([])
    await expect(client.smembers("idx:strategies")).resolves.toEqual([])
  })
})
