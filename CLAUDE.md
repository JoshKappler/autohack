# Security Bounty Hunter

TypeScript monorepo (npm workspaces) that discovers bug bounty programs across multiple platforms and autonomously hunts for security vulnerabilities using Claude Code.

## Architecture

- `orchestrator.ts` — Entry point. Schedules cron jobs for multi-provider discovery, security analysis, auto-hunting, and submission status polling.
- `packages/core/` — Shared config, database (SQLite + Drizzle), Claude wrappers, types, logging, security memory.
- `packages/security-discovery/` — Multi-provider discovery: HackerOne, Immunefi, Huntr, plus aggregator (Bugcrowd, Intigriti, YesWeHack, Federacy).
- `packages/security-analyzer/` — Assesses program opportunity and ranks/validates findings.
- `packages/security-solver/` — Spawns Claude Code to hunt for vulnerabilities in target programs, generates reports, runs adversarial reviews.
- `packages/dashboard/` — Next.js 15 dashboard for monitoring bot status (tRPC + React 19).

## Providers

| Provider | Config Flag | Source Code? | API Submission? | Notes |
|----------|-------------|-------------|-----------------|-------|
| HackerOne | `HACKERONE_ENABLED` | Some programs | Yes | Full API, auth via username+token |
| Immunefi | `IMMUNEFI_ENABLED` | All (smart contracts) | No (manual) | Crypto/web3, huge bounties ($10K-$10M), no auth needed for discovery |
| Huntr | `HUNTR_ENABLED` | All (GitHub repos) | No (manual) | AI/ML open source, no reputation gate |
| Aggregator | `AGGREGATOR_ENABLED` | Filtered to source-code-only | No | Discovers from Bugcrowd, Intigriti, YesWeHack, Federacy via bounty-targets-data |

## Commands

- `npm run dev` — Start the orchestrator (all services)
- `npm run dashboard` — Start dashboard only
- `npm run db:generate` — Generate Drizzle migrations
- `npm run db:push` — Push schema to database
- `npm run db:studio` — Open Drizzle Studio

## Key Patterns

- Two Claude backends: CLI (`CLAUDE_BACKEND=cli`, uses Max subscription) and API (`CLAUDE_BACKEND=api`, uses ANTHROPIC_API_KEY). Default is CLI.
- `runClaude()` in `packages/core/src/claude.ts` is the shared wrapper for short analysis tasks. The security solver has its own `spawnClaude` in `packages/security-solver/src/claude-runner.ts` with streaming, timeout, and PTY support.
- Config is loaded from env vars via Zod schema in `packages/core/src/config.ts`. Runtime overrides supported for dashboard control (persisted to `data/runtime-overrides.json`).
- Database is SQLite via `better-sqlite3` + `drizzle-orm`. Schema in `packages/core/src/db/schema.ts`.
- Security finding state machine: discovered → analyzing → validated → scanning → drafting → report_ready → reviewing → submitted → triaged → accepted → rewarded/dismissed/failed.
- Auto-hunt loop: picks best-scored program, spawns Claude to hunt, runs adversarial review on findings, deverbosifies approved reports, optionally auto-submits, then immediately picks the next program. Daily budget enforced via `SECURITY_MAX_DAILY_HUNTS`.
- Security memory: `packages/core/src/security-memory.ts` records hunt outcomes, finding outcomes, and near-misses for cross-hunt learning.
- Hunter prompt architecture: system prompt (stable behavioral instructions) + user message (per-program context) + minimal CLAUDE.md (cheat sheet). No duplication between layers.
- Deverbosification runs as a separate Sonnet call after adversarial review approval, keeping the reviewer focused on security judgment.
- Auto-submit: `SECURITY_AUTO_SUBMIT=true` enables automatic HackerOne submission for findings with "submit" recommendation. "submit_cautiously" findings always require manual approval.
