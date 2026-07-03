import { readFile } from "fs/promises"
import { join } from "path"

function extractFunctionBody(source: string, functionName: string): string {
  const signature = `export async function ${functionName}`
  const start = source.indexOf(signature)
  expect(start).toBeGreaterThanOrEqual(0)

  const bodyStart = source.indexOf("{\n  const now", start)
  expect(bodyStart).toBeGreaterThanOrEqual(0)

  let depth = 0
  for (let i = bodyStart; i < source.length; i++) {
    const char = source[i]
    if (char === "{") depth++
    if (char === "}") depth--
    if (depth === 0) return source.slice(bodyStart, i + 1)
  }

  throw new Error(`Could not extract ${functionName} body`)
}

describe("getRedisStats key counting", () => {
  it("uses dbSize() and does not materialize keys('*') for key count", async () => {
    const source = await readFile(join(process.cwd(), "lib", "redis-db.ts"), "utf8")
    const body = extractFunctionBody(source, "getRedisStats")

    expect(body).toContain("client.dbSize()")
    expect(body).not.toMatch(/\.keys\s*\(\s*["'`]\*["'`]\s*\)/)
  })
})
