#!/usr/bin/env node
import { readFileSync } from "node:fs"
import { relative, resolve } from "node:path"
import ts from "typescript"

const root = process.cwd()
const checks = [
  {
    file: "lib/strategy-coordinator.ts",
    pattern: /const\s+stopLossPct[\s\S]{0,240}\n\s*costModel:\s*ProtectionCostModel\s*=/,
    message:
      "Detected a truncated deriveProtectionFromProfitFactor signature before costModel. Rebuild from a clean source tree.",
  },
  {
    file: "app/api/connections/progression/[id]/stats/route.ts",
    pattern: /const\s+variantKeys\b[\s\S]*const\s+variantKeys\b/,
    message: "Detected duplicate variantKeys declarations in the stats route.",
  },
]

const syntaxFiles = [
  "app/api/trade-engine/start/route.ts",
  "lib/detailed-tracking.ts",
]

let failed = false

for (const check of checks) {
  const abs = resolve(root, check.file)
  const source = readFileSync(abs, "utf8")
  if (check.pattern.test(source)) {
    failed = true
    console.error(`[source-syntax] ${relative(root, abs)}: ${check.message}`)
  }
}

for (const file of syntaxFiles) {
  const abs = resolve(root, file)
  const source = readFileSync(abs, "utf8")
  const result = ts.transpileModule(source, {
    compilerOptions: {
      jsx: ts.JsxEmit.Preserve,
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ESNext,
    },
    fileName: abs,
    reportDiagnostics: true,
  })

  const syntaxErrors = result.diagnostics?.filter((diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error) ?? []
  for (const diagnostic of syntaxErrors) {
    failed = true
    const position = diagnostic.file?.getLineAndCharacterOfPosition(diagnostic.start ?? 0)
    const location = position ? `:${position.line + 1}:${position.character + 1}` : ""
    const message = ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n")
    console.error(`[source-syntax] ${relative(root, abs)}${location}: ${message}`)
  }
}

function assertTopLevelExport(file, exportName) {
  const abs = resolve(root, file)
  const source = readFileSync(abs, "utf8")
  const marker = `export function ${exportName}`
  const asyncMarker = `export async function ${exportName}`
  const markerToUse = source.includes(marker) ? marker : asyncMarker
  const index = source.indexOf(markerToUse)
  if (index === -1) {
    failed = true
    console.error(`[source-syntax] ${file}: Missing ${marker} or ${asyncMarker}.`)
    return
  }

  let depth = 0
  for (let i = 0; i < index; i += 1) {
    const char = source[i]
    if (char === "{") depth += 1
    if (char === "}") depth = Math.max(0, depth - 1)
  }

  if (depth !== 0) {
    failed = true
    console.error(`[source-syntax] ${file}: ${markerToUse} is nested inside an unclosed block.`)
  }
}

function assertTopLevelAsyncGet(file) {
  const abs = resolve(root, file)
  const source = readFileSync(abs, "utf8")
  const marker = "export async function GET"
  const index = source.indexOf(marker)
  if (index === -1) {
    failed = true
    console.error(`[source-syntax] ${file}: Missing ${marker}.`)
    return
  }

  let depth = 0
  for (let i = 0; i < index; i += 1) {
    const char = source[i]
    if (char === "{") depth += 1
    if (char === "}") depth = Math.max(0, depth - 1)
  }

  if (depth !== 0) {
    failed = true
    console.error(`[source-syntax] ${file}: ${marker} is nested inside an unclosed block.`)
  }
}

assertTopLevelExport("lib/trade-engine/stages/live-stage.ts", "clearMarginCooldown")
assertTopLevelExport("lib/detailed-tracking.ts", "getStrategyTracking")
assertTopLevelAsyncGet("app/api/cron/server-continuity/route.ts")

if (failed) {
  console.error("[source-syntax] Deployment source contains known merge-truncation syntax regressions.")
  process.exit(1)
}

console.log("[source-syntax] Known deployment syntax regressions are not present.")
