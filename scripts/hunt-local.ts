/**
 * hunt-local.ts — point autohack's hunt engine at a local source tree.
 *
 * Same engine the orchestrator uses (the PTY-based Claude runner, the real hunter
 * system prompt, ===FINDING=== parsing, and an adversarial self-review pass), but
 * with no SQLite and no HackerOne/Algora plumbing. Built so another project can
 * call autohack via the CLI to run an authorized white-hat session against itself.
 *
 * Usage:
 *   npx tsx scripts/hunt-local.ts \
 *     --target /path/to/repo \
 *     --name "my-project" \
 *     --scope /path/to/scope.md \
 *     --out  /path/to/report.md \
 *     --timeout-min 30 \
 *     [--model opus] [--max-turns 160] [--dry-run]
 */
import "dotenv/config";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve, basename } from "node:path";
import { readFileSync, writeFileSync, mkdirSync, existsSync, statSync } from "node:fs";

const PROJECT_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
process.env.PROJECT_ROOT = PROJECT_ROOT;
// Local hunts never touch GitHub, but loadConfig() requires a token. Default it
// so the engine's config validation passes without a real credential.
if (!process.env.GITHUB_TOKEN) process.env.GITHUB_TOKEN = "local-hunt";

import { loadConfig, extractJsonWithKey } from "@bounty/core";
import {
  spawnClaude,
  buildHunterSystemPrompt,
  buildReviewerSystemContext,
  parseFindings,
  type ParsedFinding,
} from "@bounty/security-solver";

// ── Args ─────────────────────────────────────────────────────

function parseArgs(argv: string[]): Record<string, string | boolean> {
  const out: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) {
      out[key] = true;
    } else {
      out[key] = next;
      i++;
    }
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));

function requireArg(name: string): string {
  const v = args[name];
  if (typeof v !== "string" || !v) {
    console.error(`Missing required --${name}`);
    process.exit(2);
  }
  return v;
}

const targetDir = resolve(requireArg("target"));
const targetName = (args.name as string) || basename(targetDir);
const scopePath = args.scope as string | undefined;
const outPath = resolve((args.out as string) || join(PROJECT_ROOT, "data", `hunt-${targetName}.md`));
const timeoutMin = Number(args["timeout-min"] ?? 30);
const maxTurns = Number(args["max-turns"] ?? 160);
const dryRun = args["dry-run"] === true;

if (!existsSync(targetDir) || !statSync(targetDir).isDirectory()) {
  console.error(`Target is not a directory: ${targetDir}`);
  process.exit(2);
}

const scopeText = scopePath && existsSync(scopePath)
  ? readFileSync(scopePath, "utf-8")
  : `The full source tree of "${targetName}" is the in-scope target. Treat every server endpoint, auth path, data-access boundary, and file-handling routine as fair game.`;

// Make the engine's stated time budget match the session we're actually running.
process.env.SECURITY_HUNT_TIMEOUT_MINUTES = String(timeoutMin);
process.env.SECURITY_SOURCE_CODE_TIMEOUT_MINUTES = String(timeoutMin);
const config = loadConfig();
const model = (args.model as string) || config.CLAUDE_MODEL;

// ── Prompts ──────────────────────────────────────────────────

function buildLocalHuntPrompt(): string {
  return `## Target: ${targetName} (local source-code assessment)

You are running an AUTHORIZED white-hat assessment of a single project the operator owns. The complete source tree is checked out in your current working directory (\`${targetDir}\`). This is a SOURCE_CODE target — there is no live host to attack. Read and analyze the code in place. Do NOT modify the repository. Write any scratch files, PoCs, or notes only under \`/tmp/security-audit/\`.

## In-Scope
${scopeText}

## Methodology — Follow These Phases In Order

### Phase 1: Recon (~10% of time)
Map the stack and the trust boundaries. Read the README / manifests / entrypoints. Identify: where HTTP requests enter, how auth and authorization are enforced, where tenant/user data is isolated, every place user-controlled input reaches a dangerous sink (SQL, shell, file paths, deserialization, template rendering, outbound fetch), and how secrets/config are handled. Use \`semgrep --config=auto .\` and targeted \`grep\` to find candidate sinks fast. Use the Agent tool to explore separate subsystems in parallel.

### Phase 2: Deep Investigation (bulk of time)
For each candidate, trace user input from its entry point to the sink and decide whether the path is actually reachable in production (check config, defaults, deployment manifests). Prioritize: authentication/authorization bypass, tenant isolation breaks (one user reading another's data — IDOR), injection (SQL/command/path traversal), SSRF, insecure deserialization, secret exposure that is actually secret. A vulnerable-looking line that no reachable request can hit is NOT a finding.

### Phase 3: Falsification (~10% of time)
For EACH candidate, actively try to disprove it. What middleware, framework default, validation, or escaping neutralizes it? Re-read the surrounding code. If you can talk yourself out of it, a reviewer will too. Discard anything you can't defend. Zero findings is an acceptable and common outcome.

### Phase 4: Report
Write only findings that survived Phase 3, in the exact ===FINDING_START=== / ===FINDING_END=== format defined in your system prompt. For a SOURCE_CODE target, a code trace plus a reachability argument (config/default/manifest showing the path is live) is sufficient PoC — you do not need to exploit a running deployment. Calibrate severity to demonstrated impact and go one level lower when in doubt.`;
}

function buildLocalReviewPrompt(finding: ParsedFinding): string {
  return `You are a skeptical adversarial reviewer. A white-hat hunt produced the candidate finding below for the project "${targetName}", whose source is in your current working directory (\`${targetDir}\`). Your job is to try to DISPROVE it, exactly as a hostile triager would.

Verify against the actual code:
1. Is the vulnerable code path real, and is it reachable by an attacker in a production configuration? Check middleware, framework defaults, validation, escaping, and deployment config that might neutralize it.
2. Is the claimed impact demonstrated, or speculative? Downgrade theatrical severity to real severity.
3. Is it a genuine security flaw, or a best-practice nit / false positive?

Read whatever files you need to settle it. Then output ONE JSON object (and nothing else after it) with these keys:
{
  "verdict": "approve" | "reject",
  "confidence": <0-1, your calibrated confidence the finding is real and reachable>,
  "severity": "critical" | "high" | "medium" | "low" | "informational",
  "reasoning": "<2-4 sentences: what you checked and why it stands or falls>"
}

Default to "reject" when you are not convinced the path is reachable with real impact. A false positive is worse than a missed bug.

## Candidate Finding
${finding.reportBody}`;
}

// ── Live progress ────────────────────────────────────────────

function progressReporter() {
  let last = "";
  return (m: { currentActivity?: string; currentActivityDetail?: string; toolUseCount: number }) => {
    const line = `${m.currentActivity ?? ""}${m.currentActivityDetail ? ` — ${m.currentActivityDetail}` : ""}`;
    if (line && line !== last) {
      last = line;
      process.stderr.write(`  · [${m.toolUseCount} tools] ${line}\n`);
    }
  };
}

// ── Report assembly ──────────────────────────────────────────

interface Reviewed extends ParsedFinding {
  verdict: "approve" | "reject";
  reviewConfidence: number;
  reviewSeverity: string;
  reviewReasoning: string;
}

function buildReport(reviewed: Reviewed[], rawOutputLen: number): string {
  const stamp = new Date().toISOString();
  const confirmed = reviewed.filter((f) => f.verdict === "approve");
  const rejected = reviewed.filter((f) => f.verdict === "reject");

  const lines: string[] = [];
  lines.push(`# Security Hunt Report — ${targetName}`);
  lines.push("");
  lines.push(`> Generated by [**autohack**](https://github.com/JoshKappler/autohack) running a local-target white-hat session.`);
  lines.push(`> Same engine that hunts live bug-bounty programs (PTY Claude hunt + adversarial self-review), pointed at this repo.`);
  lines.push("");
  lines.push(`- **Target:** \`${targetDir}\``);
  lines.push(`- **Run at:** ${stamp}`);
  lines.push(`- **Model / budget:** ${model}, ${timeoutMin} min, ${maxTurns} turns`);
  lines.push(`- **Candidates found:** ${reviewed.length} — **confirmed after adversarial review:** ${confirmed.length}, **filtered:** ${rejected.length}`);
  lines.push("");

  if (confirmed.length === 0) {
    lines.push(`## No confirmed findings`);
    lines.push("");
    lines.push(`The hunt surfaced ${reviewed.length} candidate(s); none survived adversarial self-review. For a hardened, scoped codebase this is the expected outcome — the value here is the documented attack surface and the falsification trail below.`);
    lines.push("");
  } else {
    lines.push(`## Confirmed Findings`);
    lines.push("");
    confirmed.forEach((f, i) => {
      lines.push(`### ${i + 1}. ${f.title}`);
      lines.push("");
      lines.push(`**Severity:** ${f.reviewSeverity || f.severity} · **Reviewer confidence:** ${f.reviewConfidence.toFixed(2)}`);
      lines.push("");
      lines.push(`**Adversarial review (APPROVED):** ${f.reviewReasoning}`);
      lines.push("");
      lines.push(f.reportBody);
      lines.push("");
      lines.push("---");
      lines.push("");
    });
  }

  if (rejected.length > 0) {
    lines.push(`## Filtered by Adversarial Review`);
    lines.push("");
    lines.push(`Candidates the hunt raised that the adversarial reviewer could not stand up. This is the false-positive filter working — they are listed for transparency, not as live issues.`);
    lines.push("");
    rejected.forEach((f) => {
      lines.push(`- **${f.title}** (${f.severity}) — ${f.reviewReasoning}`);
    });
    lines.push("");
  }

  lines.push(`## Scope`);
  lines.push("");
  lines.push("```");
  lines.push(scopeText.trim());
  lines.push("```");
  lines.push("");
  lines.push(`<sub>Raw hunt transcript captured under autohack/data/logs. Output length: ${rawOutputLen} chars.</sub>`);
  return lines.join("\n");
}

// ── Main ─────────────────────────────────────────────────────

async function main() {
  const systemPrompt = buildHunterSystemPrompt();
  const huntPrompt = buildLocalHuntPrompt();

  if (dryRun) {
    console.log("DRY RUN — engine wired, no Claude session spawned.");
    console.log(JSON.stringify({
      target: targetDir,
      name: targetName,
      scopeChars: scopeText.length,
      out: outPath,
      model,
      timeoutMin,
      maxTurns,
      systemPromptChars: systemPrompt.length,
      huntPromptChars: huntPrompt.length,
      claudeBackend: config.CLAUDE_BACKEND,
    }, null, 2));
    return;
  }

  const logDir = join(PROJECT_ROOT, "data", "logs");
  mkdirSync(logDir, { recursive: true });
  mkdirSync(dirname(outPath), { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const huntLog = join(logDir, `local-hunt-${targetName}-${ts}.log`);

  process.stderr.write(`\n▶ autohack white-hat session on "${targetName}" (${model}, ${timeoutMin} min)\n`);
  process.stderr.write(`  target: ${targetDir}\n\n`);

  const huntOutput = await spawnClaude(
    huntPrompt,
    huntLog,
    timeoutMin * 60_000,
    progressReporter(),
    { systemPrompt, cwd: targetDir, model, maxTurns, effort: "high" },
  );

  const findings = parseFindings(huntOutput);
  process.stderr.write(`\n✔ hunt complete — ${findings.length} candidate finding(s) passed the basic gate.\n`);

  // Adversarial self-review: a fresh Claude instance tries to disprove each candidate.
  const reviewed: Reviewed[] = [];
  for (let i = 0; i < findings.length; i++) {
    const f = findings[i];
    process.stderr.write(`\n⚔ adversarial review ${i + 1}/${findings.length}: ${f.title}\n`);
    const reviewLog = join(logDir, `local-review-${targetName}-${ts}-${i}.log`);
    let verdict: "approve" | "reject" = "reject";
    let reviewConfidence = f.confidence;
    let reviewSeverity = f.severity;
    let reviewReasoning = "Reviewer produced no parseable verdict; defaulted to reject.";
    try {
      const reviewOut = await spawnClaude(
        buildLocalReviewPrompt(f),
        reviewLog,
        Math.max(10, Math.round(timeoutMin / 2)) * 60_000,
        progressReporter(),
        { systemPrompt: buildReviewerSystemContext(), cwd: targetDir, model, maxTurns: 80, effort: "high" },
      );
      const parsed = extractJsonWithKey<any>(reviewOut, "verdict");
      if (parsed) {
        verdict = parsed.verdict === "approve" ? "approve" : "reject";
        if (typeof parsed.confidence === "number") reviewConfidence = Math.max(0, Math.min(1, parsed.confidence));
        if (typeof parsed.severity === "string") reviewSeverity = parsed.severity.toLowerCase();
        if (typeof parsed.reasoning === "string") reviewReasoning = parsed.reasoning;
      }
    } catch (err: any) {
      reviewReasoning = `Review pass errored (${err?.message ?? err}); defaulted to reject.`;
    }
    process.stderr.write(`  → ${verdict.toUpperCase()} (${reviewConfidence.toFixed(2)})\n`);
    reviewed.push({ ...f, verdict, reviewConfidence, reviewSeverity, reviewReasoning });
  }

  const report = buildReport(reviewed, huntOutput.length);
  writeFileSync(outPath, report, "utf-8");

  const confirmed = reviewed.filter((r) => r.verdict === "approve").length;
  process.stderr.write(`\n${"=".repeat(60)}\n`);
  process.stderr.write(`Done. ${confirmed} confirmed / ${reviewed.length} candidates.\n`);
  // stdout: the one machine-readable line the caller (corgi) keys off.
  console.log(JSON.stringify({ ok: true, report: outPath, candidates: reviewed.length, confirmed }));
}

main().catch((err) => {
  console.error(`hunt-local failed: ${err?.stack ?? err}`);
  process.exit(1);
});
