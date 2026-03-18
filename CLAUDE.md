# Algora Bounty Bot

TypeScript monorepo (pnpm workspaces) that discovers GitHub bounties and solves them autonomously using Claude Code.

## Architecture

- `orchestrator.ts` — Entry point. Schedules cron jobs for discovery, analysis, solving, and review monitoring.
- `packages/core/` — Shared config, database (SQLite + Drizzle), Claude wrappers, types, logging, memory.
- `packages/discovery/` — Polls Algora API and GitHub for open bounties.
- `packages/analyzer/` — Feasibility assessment and priority-based ranking of discovered bounties.
- `packages/solver/` — Clones repos, spawns Claude Code to solve issues, creates PRs.
- `packages/monitor/` — Watches PR reviews, auto-responds to feedback, auto-fixes code.
- `packages/dashboard/` — Next.js 15 dashboard for monitoring bot status (tRPC + React 19).

## Commands

- `npm run dev` — Start the orchestrator (all services)
- `npm run dashboard` — Start dashboard only
- `npm run db:generate` — Generate Drizzle migrations
- `npm run db:push` — Push schema to database
- `npm run db:studio` — Open Drizzle Studio

## Key Patterns

- Two Claude backends: CLI (`CLAUDE_BACKEND=cli`, uses Max subscription) and API (`CLAUDE_BACKEND=api`, uses ANTHROPIC_API_KEY). Default is CLI.
- `runClaude()` in `packages/core/src/claude.ts` is the shared wrapper for short analysis tasks (feasibility, self-review, PR description, review response). The solver has its own `spawnClaude` in `packages/solver/src/claude-runner.ts` with streaming, retry logic, and higher turn limits.
- Config is loaded from env vars via Zod schema in `packages/core/src/config.ts`. Runtime overrides supported for dashboard control.
- Database is SQLite via `better-sqlite3` + `drizzle-orm`. Schema in `packages/core/src/db/schema.ts`.
- Bounty state machine: discovered → analyzing → selected → attempting → solving → pr_created → in_review → merged/rejected/failed.
- Priority score formula: `reward × feasibility / (estimatedHours × (1 + competitors))`. Higher = solve first.
- Pipeline tracing: every analysis and solve run gets a `traceId` (e.g., `trc_a1b2c3d4`) stored in `pipelineRuns`. Errors are classified into categories (transient, permanent, validation, timeout, no_changes, git_error) for the Traces dashboard.
