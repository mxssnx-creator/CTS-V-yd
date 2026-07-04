import { mkdtemp, rm } from "fs/promises"
import { tmpdir } from "os"
import { join } from "path"

import { InlineLocalRedis } from "@/lib/redis-db"

function resetInlineGlobals() {
  delete (globalThis as any).__redis_data
  delete (globalThis as any).__redis_load_promise
  delete (globalThis as any).__redis_snapshot_loaded
  delete (globalThis as any).__redis_cleanup_started
  delete (globalThis as any).__db_ops_tracker
}

describe("InlineLocalRedis compatibility and persistence", () => {
  const originalEnv = { ...process.env }

  beforeEach(() => {
    jest.useRealTimers()
    process.env = { ...originalEnv, NODE_ENV: "test" }
    resetInlineGlobals()
  })

  afterEach(() => {
    resetInlineGlobals()
    process.env = originalEnv
  })

  it("supports the Redis command surface used by application callers", async () => {
    const redis = new InlineLocalRedis()

    await expect(redis.ping()).resolves.toBe("PONG")
    await expect(redis.set("string:key", "value")).resolves.toBe("OK")
    await expect(redis.get("string:key")).resolves.toBe("value")
    await expect(redis.mget("string:key", "missing")).resolves.toEqual(["value", null])

    await expect(redis.hset("hash:key", { a: "1", b: "2" })).resolves.toBe(2)
    await expect(redis.hset("hash:key", "c", "3")).resolves.toBe(1)
    await expect(redis.hget("hash:key", "a")).resolves.toBe("1")
    await expect(redis.hgetall("hash:key")).resolves.toEqual({ a: "1", b: "2", c: "3" })
    await expect(redis.hincrby("hash:key", "a", 2)).resolves.toBe(3)
    await expect(redis.hincrbyfloat("hash:key", "float", 1.5)).resolves.toBe(1.5)
    await expect(redis.hdel("hash:key", "b")).resolves.toBe(1)

    await expect(redis.sadd("set:key", "one", "two", "two")).resolves.toBe(2)
    await expect(redis.scard("set:key")).resolves.toBe(2)
    await expect(redis.sismember("set:key", "one")).resolves.toBe(1)
    await expect(redis.smembers("set:key")).resolves.toEqual(expect.arrayContaining(["one", "two"]))
    await expect(redis.srem("set:key", "two")).resolves.toBe(1)

    await expect(redis.lpush("list:key", "b", "a")).resolves.toBe(2)
    await expect(redis.rpush("list:key", "c")).resolves.toBe(3)
    await expect(redis.lrange("list:key", 0, -1)).resolves.toEqual(["a", "b", "c"])
    await expect(redis.lpos("list:key", "b")).resolves.toBe(1)
    await expect(redis.lrem("list:key", 1, "b")).resolves.toBe(1)
    await expect(redis.lpop("list:key")).resolves.toBe("a")
    await expect(redis.rpop("list:key")).resolves.toBe("c")

    await expect(redis.zadd("z:key", 2, "two")).resolves.toBe(1)
    await expect(redis.zadd("z:key", 1, "one")).resolves.toBe(1)
    await expect(redis.zrange("z:key", 0, -1)).resolves.toEqual(["one", "two"])
    await expect(redis.zrevrange("z:key", 0, -1)).resolves.toEqual(["two", "one"])
    await expect(redis.zscore("z:key", "two")).resolves.toBe("2")
    await expect(redis.zrangebyscore("z:key", 1, 2)).resolves.toEqual(["one", "two"])

    await expect(redis.expire("string:key", 30)).resolves.toBe(1)
    await expect(redis.ttl("string:key")).resolves.toBeGreaterThan(0)
    await expect(redis.keys("*:key")).resolves.toEqual(expect.arrayContaining(["string:key", "hash:key", "set:key", "z:key"]))
    await expect(redis.dbSize()).resolves.toBeGreaterThanOrEqual(4)

    const pipelineResult = await redis
      .multi()
      .set("pipe:key", "ok")
      .get("pipe:key")
      .hset("pipe:hash", { field: "value" })
      .hgetall("pipe:hash")
      .exec()

    expect(pipelineResult).toEqual(["OK", "ok", 1, { field: "value" }])
  })

  it("persists and restores all supported data structures from the snapshot file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "inline-redis-"))
    const snapshotPath = join(dir, "redis-snapshot.json")
    process.env.V0_REDIS_SNAPSHOT_PATH = snapshotPath

    try {
      const writer = new InlineLocalRedis()
      await writer.set("string:persist", "value")
      await writer.hset("hash:persist", { field: "value" })
      await writer.sadd("set:persist", "member")
      await writer.rpush("list:persist", "first", "second")
      await writer.zadd("z:persist", 10, "member")
      await writer.expire("string:persist", 60)

      await expect(writer.saveToDisk()).resolves.toBe(true)

      resetInlineGlobals()
      const reader = new InlineLocalRedis()
      await expect(reader.loadFromDisk()).resolves.toBe(true)

      await expect(reader.get("string:persist")).resolves.toBe("value")
      await expect(reader.hgetall("hash:persist")).resolves.toEqual({ field: "value" })
      await expect(reader.smembers("set:persist")).resolves.toEqual(["member"])
      await expect(reader.lrange("list:persist", 0, -1)).resolves.toEqual(["first", "second"])
      await expect(reader.zscore("z:persist", "member")).resolves.toBe("10")
      await expect(reader.ttl("string:persist")).resolves.toBeGreaterThan(0)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it("keeps sorted sets ordered while updating duplicate members and slicing score ranges", async () => {
    const redis = new InlineLocalRedis()

    await expect(redis.zadd("z:updates", 30, "thirty")).resolves.toBe(1)
    await expect(redis.zadd("z:updates", 10, "ten")).resolves.toBe(1)
    await expect(redis.zadd("z:updates", 20, "twenty")).resolves.toBe(1)
    await expect(redis.zadd("z:updates", 20, "twenty-b")).resolves.toBe(1)

    await expect(redis.zrange("z:updates", 0, -1)).resolves.toEqual(["ten", "twenty", "twenty-b", "thirty"])
    await expect(redis.zrangebyscore("z:updates", 15, 25)).resolves.toEqual(["twenty", "twenty-b"])

    await expect(redis.zadd("z:updates", 5, "twenty")).resolves.toBe(0)
    await expect(redis.zscore("z:updates", "twenty")).resolves.toBe("5")
    await expect(redis.zrange("z:updates", 0, -1)).resolves.toEqual(["twenty", "ten", "twenty-b", "thirty"])
    await expect(redis.zrangebyscore("z:updates", "-inf", 10)).resolves.toEqual(["twenty", "ten"])
    await expect(redis.zcard("z:updates")).resolves.toBe(4)

    await expect(redis.zremrangebyscore("z:updates", 10, 20)).resolves.toBe(2)
    await expect(redis.zrange("z:updates", 0, -1)).resolves.toEqual(["twenty", "thirty"])
    await expect(redis.zscore("z:updates", "ten")).resolves.toBeNull()
    await expect(redis.zrangebyscore("z:updates", 0, "+inf")).resolves.toEqual(["twenty", "thirty"])
  })

  it("rebuilds sorted-set member indexes after snapshot reload", async () => {
    const dir = await mkdtemp(join(tmpdir(), "inline-redis-zset-"))
    const snapshotPath = join(dir, "redis-snapshot.json")
    process.env.V0_REDIS_SNAPSHOT_PATH = snapshotPath

    try {
      const writer = new InlineLocalRedis()
      await writer.zadd("z:snapshot", 100, "hundred")
      await writer.zadd("z:snapshot", 50, "fifty")
      await writer.zadd("z:snapshot", 75, "seventy-five")
      await writer.zadd("z:snapshot", 60, "fifty")
      await expect(writer.saveToDisk()).resolves.toBe(true)

      resetInlineGlobals()
      const reader = new InlineLocalRedis()
      await expect(reader.loadFromDisk()).resolves.toBe(true)

      await expect(reader.zrange("z:snapshot", 0, -1)).resolves.toEqual(["fifty", "seventy-five", "hundred"])
      await expect(reader.zscore("z:snapshot", "fifty")).resolves.toBe("60")
      await expect(reader.zadd("z:snapshot", 40, "hundred")).resolves.toBe(0)
      await expect(reader.zrangebyscore("z:snapshot", 0, 70)).resolves.toEqual(["hundred", "fifty"])
      await expect(reader.zremrangebyscore("z:snapshot", 50, 80)).resolves.toBe(2)
      await expect(reader.zrange("z:snapshot", 0, -1)).resolves.toEqual(["hundred"])
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
