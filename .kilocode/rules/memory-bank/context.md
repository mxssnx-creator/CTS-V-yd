# Active Context: CTS-V-yd Trading Platform

## Current State

**Project**: CTS-V-yd — a Next.js 15 (App Router) cryptocurrency trading coordination platform. It is loaded as the active workspace project, with the working branch `kilo` based on `github/main`.

**Status**: ✅ Fully loaded, typechecks, lints, and builds cleanly (40/40 static pages).

## Recently Completed

- [x] Cloned full CTS-V-yd repo (github `main`) into the workspace
- [x] Committed project into the builder git `main` so it persists across sandbox resets
- [x] Created `kilo` branch (based on `github/main`) and pushed to GitHub
- [x] Installed dependencies with `bun install`
- [x] Fixed 3 typecheck errors in `lib/client-session-persistence.ts` and `lib/redis-persistence.ts`
- [x] Verified `bun typecheck`, `bun lint`, and `bun run build` all pass

## Current Structure

| File/Directory | Purpose | Status |
|----------------|---------|--------|
| `app/` | Next.js App Router pages/routes | ✅ Loaded |
| `lib/` | Core trading engine / coordination / persistence logic | ✅ Loaded |
| `components/` | UI components | ✅ Loaded |
| `pnpm-lock.yaml` | Lockfile (pnpm) | ✅ Kept |
| `next.config.mjs` | Next.js config | ✅ Loaded |

## Current Focus

Working on the `kilo` branch (tracks `github/kilo`). Recent fixes addressed TypeScript strict-mode errors in the Redis/client session persistence modules.

## Git Notes

- `origin` = app-builder git (kiloapps). The sandbox resets the working tree to this git's `main` HEAD, so **CTS-V-yd content and fixes MUST be committed to the builder `main`** to persist (untracked/modified files get reverted).
- `github` remote = `github.com/mxssnx-creator/CTS-V-yd` (auth via token). `kilo` branch tracks `github/kilo` and is pushed there.
- `kilo` is based on `github/main` (clean history). Recreate with `git checkout -B kilo github/main` to avoid divergence.
- `.kilocode/` and `AGENTS.md` are environment-specific and intentionally KEPT UNTRACKED (restored from builder `main` after branch switches).
- `.v0-data/` (runtime Redis snapshots) is gitignored.
- Repo uses `pnpm-lock.yaml`; `bun.lock` from `bun install` is removed to avoid conflicts.

## Session History

| Date | Changes |
|------|---------|
| Initial | Template created with base setup |
| 2026-07-07 | Loaded CTS-V-yd as the project; committed to builder main; created + pushed `kilo`; fixed typecheck errors; build verified |
