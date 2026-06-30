type MinimalFs = {
  existsSync: (path: string) => boolean
  readFileSync: (path: string, encoding: "utf8") => string
}

function loadFs(): MinimalFs | null {
  if (typeof window !== "undefined") return null
  try {
    // Avoid a static `fs` import because base credential helpers are imported by
    // some client-bundled settings/predefinition modules. Server code can still
    // read local dotenv files during `next start`; browser bundles get a safe
    // no-file fallback and rely only on inlined process.env values.
    const req = eval("require") as (id: string) => MinimalFs
    return req("node:fs")
  } catch {
    return null
  }
}

function cwdFile(name: string): string {
  const cwd = typeof process !== "undefined" && typeof process.cwd === "function" ? process.cwd() : ""
  return `${cwd.replace(/\/$/, "")}/${name}`
}

const BINGX_KEY_ALIASES = ["BINGX_API_KEY", "BINGX_APIKEY", "NEXT_BINGX_API_KEY", "NEXT_PUBLIC_BINGX_API_KEY"]
const BINGX_SECRET_ALIASES = ["BINGX_API_SECRET", "BINGX_SECRET", "NEXT_BINGX_API_SECRET", "NEXT_PUBLIC_BINGX_API_SECRET"]

let parsedDotenv: Record<string, string> | null = null

function parseDotenvLine(line: string): [string, string] | null {
  const trimmed = line.trim()
  if (!trimmed || trimmed.startsWith("#")) return null
  const separator = trimmed.indexOf("=")
  if (separator <= 0) return null
  const key = trimmed.slice(0, separator).trim()
  const value = trimmed.slice(separator + 1).trim()
  return [key, value]
}

function loadDotenvFallback(): Record<string, string> {
  if (parsedDotenv) return parsedDotenv

  const fs = loadFs()
  if (!fs) {
    parsedDotenv = {}
    return parsedDotenv
  }

  const files = [
    // Match the files operators actually use with `next dev` and
    // local `next start`/production smoke tests. Values earlier in this
    // list win, while real process.env still wins over every file below.
    cwdFile(`.env.${process.env.NODE_ENV || "development"}.local`),
    cwdFile(".env.local"),
    cwdFile(".env.production.local"),
    cwdFile(".env.development.local"),
    cwdFile(".env"),
  ]

  const loaded: Record<string, string> = {}
  for (const file of files) {
    if (!fs.existsSync(file)) continue
    const text = fs.readFileSync(file, "utf8")
    for (const line of text.split(/\r?\n/)) {
      const parsed = parseDotenvLine(line)
      if (!parsed) continue
      const [key, value] = parsed
      if (!(key in loaded)) loaded[key] = value
    }
  }

  parsedDotenv = loaded
  return loaded
}

function cleanEnvValue(raw: string | undefined): string {
  if (!raw) return ""
  return raw.trim().replace(/^['\"]|['\"]$/g, "")
}

export function readEnvByAliases(aliases: string[]): string {
  const dotenv = loadDotenvFallback()
  for (const key of aliases) {
    const value = cleanEnvValue(process.env[key] || dotenv[key])
    if (value.length > 0) return value
  }
  return ""
}

export function readBingxCredentialsFromEnv(): { apiKey: string; apiSecret: string; hasCredentials: boolean } {
  const apiKey = readEnvByAliases(BINGX_KEY_ALIASES)
  const apiSecret = readEnvByAliases(BINGX_SECRET_ALIASES)
  const hasCredentials = apiKey.length > 10 && apiSecret.length > 10
  return { apiKey, apiSecret, hasCredentials }
}
