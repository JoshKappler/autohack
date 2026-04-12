# autohack

Autonomous vulnerability hunter across HackerOne, Immunefi, Huntr, Bugcrowd, and Intigriti. Discovers bug bounty programs, hunts vulnerabilities using Claude, validates findings via adversarial self-review, and auto-submits reports.

Built with direct SDK calls — no LangChain, no CrewAI, no framework wrappers.

## What it does

1. **Discovery** — polls 5 bounty platforms, aggregates and deduplicates targets, ranks by payout and scope.
2. **Analysis** — pulls the target's scope, prior reports, and asset inventory, then produces a hunt strategy.
3. **Hunt** — spawns Claude for a 60-minute hunt session with a scoped cheat sheet and target details. Claude works autonomously on recon, exploit discovery, and finding validation.
4. **Adversarial self-review** — a second Claude instance attacks the finding from the opposite direction, tries to disprove it, filters out false positives, and downgrades theatrical severity to real severity.
5. **Report drafting** — generates a HackerOne-formatted report with reproduction steps, impact analysis, and remediation suggestions.
6. **Submission** — optionally auto-submits to HackerOne through the API (gated behind an approval flag).

## Architecture

```
packages/
  core/                 shared config, DB, logging, Claude wrappers
  security-discovery/   HackerOne, Immunefi, Huntr, Bugcrowd, Intigriti pollers
  security-analyzer/    target ranking and feasibility
  security-solver/      PTY-based Claude spawning, 60-min hunt sessions
  security-memory/      cross-hunt outcome and near-miss learning
  dashboard/            Next.js 15 monitoring UI
orchestrator.ts         cron-scheduled hunt loop
```

Findings move through a 12-state pipeline:

`discovered -> analyzing -> validated -> scanning -> drafting -> reviewing -> submitted -> triaged -> accepted / rewarded / rejected / duplicate`

## Key patterns

- **PTY-based Claude spawning.** Hunts run in a pseudo-terminal so output streams in real time to the dashboard via xterm.js. Hard timeout at 60 minutes with graceful shutdown.
- **Dual Claude backends.** Claude Max via CLI or the Anthropic API via SDK. Switch via `CLAUDE_BACKEND=cli|api`.
- **Cross-hunt security memory.** Every hunt writes its findings, near-misses, and dead ends to a persistent memory layer. New hunts prime the model with relevant prior context so it does not re-explore known dead ends.
- **Adversarial self-review.** A finding moves from `scanning` to `drafting` only after a second Claude instance tries to disprove it. This filters out hallucinated findings before they hit a report draft.
- **Cross-process lock file** prevents two hunts from touching the same target simultaneously.
- **Prompt layering.** Stable behavior in the system prompt (cached via `cache_control`), dynamic target context in the user prompt.

## Stack

TypeScript · Node.js · Next.js 15 · SQLite + Drizzle ORM · tRPC · Anthropic SDK · Pino · node-cron · pnpm monorepo

## Running locally

```bash
pnpm install
cp .env.example .env    # set HACKERONE_API_TOKEN, IMMUNEFI_API_KEY, etc.
pnpm dev                # orchestrator + dashboard on :3456
```

## Scope and ethics

Only hunts against targets with active, in-scope bug bounty programs. Never attacks systems without authorization. The cheat sheet and prompt scaffolding explicitly bound Claude to the declared scope of each bounty program. All submissions go through a manual approval gate unless the user explicitly enables auto-submit.
