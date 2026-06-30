import { jest } from "@jest/globals"

const connect = jest.fn(async () => undefined)
const ping = jest.fn(async () => "PONG")
const createClient = jest.fn(() => ({
  isOpen: false,
  on: jest.fn(),
  connect,
  ping,
}))

jest.mock("redis", () => ({ createClient }))
jest.mock("@/lib/redis-migrations", () => ({
  runMigrations: jest.fn(async () => undefined),
  resetMigrationRunState: jest.fn(),
}))

describe("redis-db production Redis client selection", () => {
  const originalEnv = { ...process.env }

  beforeEach(() => {
    jest.resetModules()
    createClient.mockClear()
    connect.mockClear()
    ping.mockClear()
    process.env = { ...originalEnv, NODE_ENV: "production", REDIS_URL: "redis://localhost:6379" }
    delete (globalThis as any).__redis_core_promise
    delete (globalThis as any).__redis_init_promise
    delete (globalThis as any).__redis_fully_connected
    delete (globalThis as any).__redis_backend
    delete (globalThis as any).__redis_data
  })

  afterAll(() => {
    process.env = originalEnv
  })

  it("uses the network Redis adapter instead of InlineLocalRedis when REDIS_URL is configured", async () => {
    const redisDb = await import("@/lib/redis-db")

    await redisDb.initRedis()
    const client = redisDb.getRedisClient()

    expect(redisDb.getRedisBackend()).toBe("redis-network")
    expect(client).not.toBeInstanceOf(redisDb.InlineLocalRedis)
    expect(createClient).toHaveBeenCalledWith({ url: "redis://localhost:6379" })
    expect(connect).toHaveBeenCalledTimes(1)
    expect(ping).toHaveBeenCalledTimes(1)
  })
})
