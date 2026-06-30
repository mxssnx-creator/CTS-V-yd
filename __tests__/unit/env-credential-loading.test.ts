import fs from "node:fs"
import os from "node:os"
import path from "node:path"

describe("production credential env loading", () => {
  const originalCwd = process.cwd()
  const originalNodeEnv = process.env.NODE_ENV
  const originalKey = process.env.BINGX_API_KEY
  const originalSecret = process.env.BINGX_API_SECRET

  afterEach(() => {
    process.chdir(originalCwd)
    process.env.NODE_ENV = originalNodeEnv
    if (originalKey === undefined) delete process.env.BINGX_API_KEY
    else process.env.BINGX_API_KEY = originalKey
    if (originalSecret === undefined) delete process.env.BINGX_API_SECRET
    else process.env.BINGX_API_SECRET = originalSecret
    jest.resetModules()
  })

  test("base BingX credentials can be loaded from .env.production.local for next start smoke runs", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cts-v-env-"))
    fs.writeFileSync(
      path.join(tmp, ".env.production.local"),
      [
        "BINGX_API_KEY=fake-prod-key-1234567890",
        "BINGX_API_SECRET=fake-prod-secret-1234567890",
        "",
      ].join("\n"),
      "utf8",
    )

    process.chdir(tmp)
    process.env.NODE_ENV = "production"
    delete process.env.BINGX_API_KEY
    delete process.env.BINGX_API_SECRET
    jest.resetModules()

    const { getBaseConnectionCredentials } = await import("@/lib/base-connection-credentials")
    expect(getBaseConnectionCredentials("bingx-x01")).toEqual({
      apiKey: "fake-prod-key-1234567890",
      apiSecret: "fake-prod-secret-1234567890",
    })
  })
})
