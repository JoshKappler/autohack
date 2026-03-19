import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { writeFile, readFile, mkdir, appendFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { existsSync } from "node:fs";
import {
  getConfig,
  createLogger,
  getLearningContext,
  type Bounty,
  type SolveResult,
} from "@algora/core";
import { writeSolverStatus, clearSolverStatus } from "./status";

const execFileAsync = promisify(execFile);
const log = createLogger("claude-runner");

// Track the active child process so it can be killed from outside
let activeChild: ReturnType<typeof spawn> | null = null;

export function getActiveChildPid(): number | null {
  return activeChild?.pid ?? null;
}

/**
 * Kill the active Claude solver process if one is running.
 * Returns true if a process was killed, false if nothing was running.
 */
export function killActiveProcess(): boolean {
  if (activeChild && !activeChild.killed) {
    log.warn({ pid: activeChild.pid }, "Force-killing active Claude process");
    activeChild.kill("SIGTERM");
    // Give it 3 seconds then SIGKILL
    const child = activeChild;
    setTimeout(() => {
      if (!child.killed) {
        child.kill("SIGKILL");
      }
    }, 3000);
    return true;
  }
  return false;
}

function getClaudeEnv() {
  const config = getConfig();
  const env = { ...process.env };
  if (config.CLAUDE_BACKEND === "cli") delete env.ANTHROPIC_API_KEY;
  return env;
}

function getLogDir(): string {
  const root = process.env.PROJECT_ROOT || process.cwd();
  return join(root, "data", "logs");
}

async function generateCodebaseContext(repoPath: string): Promise<void> {
  const claudeMdPath = join(repoPath, "CLAUDE.md");

  // If the repo already has a CLAUDE.md, respect it — the maintainer's
  // instructions are more valuable than anything we can auto-generate
  if (existsSync(claudeMdPath)) {
    log.info("Repo already has CLAUDE.md — using existing project instructions");
    return;
  }

  const sections: string[] = [];

  try {
    const { stdout } = await execFileAsync(
      "find",
      [
        ".", "-maxdepth", "3",
        "-not", "-path", "*/node_modules/*",
        "-not", "-path", "*/.git/*",
        "-not", "-path", "*/vendor/*",
        "-not", "-path", "*/__pycache__/*",
        "-not", "-path", "*/target/*",
        "-not", "-path", "*/.next/*",
        "-not", "-name", "*.lock",
        "-not", "-name", "package-lock.json",
      ],
      { cwd: repoPath, timeout: 10_000 },
    );
    sections.push(`## File Structure\n\`\`\`\n${stdout.slice(0, 3000)}\n\`\`\``);
  } catch {}

  for (const readme of ["README.md", "readme.md", "README.rst", "README"]) {
    const readmePath = join(repoPath, readme);
    if (existsSync(readmePath)) {
      try {
        const content = await readFile(readmePath, "utf-8");
        sections.push(`## README\n${content.slice(0, 2000)}`);
      } catch {}
      break;
    }
  }

  const packageJsonPath = join(repoPath, "package.json");
  if (existsSync(packageJsonPath)) {
    try {
      const pkg = JSON.parse(await readFile(packageJsonPath, "utf-8"));
      if (pkg.scripts) {
        const scriptList = Object.entries(pkg.scripts)
          .map(([k, v]) => `- \`npm run ${k}\`: ${v}`)
          .join("\n");
        sections.push(`## Available Scripts\n${scriptList}`);
      }
    } catch {}
  }

  const makefilePath = join(repoPath, "Makefile");
  if (existsSync(makefilePath)) {
    try {
      const { stdout } = await execFileAsync(
        "grep",
        ["-E", "^[a-zA-Z_-]+:", makefilePath],
        { timeout: 5_000 },
      );
      sections.push(`## Makefile Targets\n\`\`\`\n${stdout.slice(0, 1000)}\n\`\`\``);
    } catch {}
  }

  if (sections.length > 0) {
    const contextDoc = `# Codebase Context (auto-generated for solver)\n\n${sections.join("\n\n")}`;
    await writeFile(claudeMdPath, contextDoc, "utf-8");
    // Ensure the generated file is git-ignored so it doesn't leak into PRs
    const gitExcludePath = join(repoPath, ".git", "info", "exclude");
    await appendFile(gitExcludePath, "\nCLAUDE.md\n").catch(() => {});
    log.info("Generated CLAUDE.md context file (git-excluded)");
  }
}

async function fetchIssueComments(bounty: Bounty): Promise<string> {
  try {
    const { stdout } = await execFileAsync(
      "gh",
      [
        "issue", "view", String(bounty.issueNumber),
        "--repo", `${bounty.repoOwner}/${bounty.repoName}`,
        "--comments",
        "--json", "comments",
        "--jq", '.comments[] | select(.author.login != "github-actions" and .author.login != "algora-pbc") | "**@\\(.author.login):** \\(.body)"',
      ],
      { timeout: 15_000 },
    );
    const trimmed = stdout.trim();
    if (trimmed.length > 0) {
      return `\n## Issue Comments\n${trimmed.slice(0, 4000)}\n`;
    }
  } catch {
    log.debug({ bountyId: bounty.id }, "Could not fetch issue comments");
  }
  return "";
}

/**
 * Fetch the latest issue body directly from GitHub to ensure we have the
 * most up-to-date and complete description (may differ from what was stored
 * at discovery time).
 */
async function fetchLatestIssueBody(bounty: Bounty): Promise<string> {
  try {
    const { stdout } = await execFileAsync(
      "gh",
      [
        "issue", "view", String(bounty.issueNumber),
        "--repo", `${bounty.repoOwner}/${bounty.repoName}`,
        "--json", "body",
        "--jq", ".body",
      ],
      { timeout: 15_000 },
    );
    const body = stdout.trim();
    if (body.length > 0) return body;
  } catch {
    log.debug({ bountyId: bounty.id }, "Could not fetch latest issue body from GitHub");
  }
  // Fall back to stored body
  return bounty.body ?? "(no issue body available)";
}

async function buildPrompt(bounty: Bounty, issueBody: string, issueComments: string): Promise<string> {
  let analysisApproach = "";
  let riskFactors: string[] = [];
  if (bounty.analysisNotes) {
    try {
      const notes = JSON.parse(bounty.analysisNotes);
      analysisApproach = notes.approach ?? "";
      riskFactors = notes.riskFactors ?? [];
    } catch {}
  }

  const riskSection = riskFactors.length > 0
    ? `\n## Known Risks\n${riskFactors.map((r: string) => `- ${r}`).join("\n")}\n`
    : "";

  // Inject cross-solve learning context
  const learningContext = await getLearningContext();
  const learningSection = learningContext
    ? `\n${learningContext}\nUse this context to avoid repeating past mistakes.\n`
    : "";

  return `You are an expert software engineer solving GitHub issue #${bounty.issueNumber} in ${bounty.repoOwner}/${bounty.repoName}. A bounty of $${(bounty.rewardCents / 100).toFixed(2)} is attached — your solution will be submitted as a pull request.

IMPORTANT: This bounty is confirmed open and unsolved by the maintainers. The issue has NOT been fixed yet. Even if prior commits or merged PRs appear to address it, the maintainers have confirmed the problem persists — otherwise the bounty would have been closed. Do not conclude the issue is already resolved. If you think it is, you are mistaken and must investigate more deeply.
${learningSection}

## Issue: ${bounty.title}

${issueBody}
${issueComments}
## Strategy
${analysisApproach || "No pre-analyzed approach available. Read the codebase carefully to determine the best fix."}
${riskSection}
## Your workflow

1. **Understand first.** Read the codebase thoroughly before writing any code. Use subagents to explore the repo structure, related files, tests, and CI configuration in parallel. Understand the coding conventions, naming patterns, and architecture.

2. **Implement the solution.** Follow the strategy above. Make focused changes that solve the issue correctly. Match existing code style exactly — indentation, naming conventions, import patterns, comment style.

3. **If your first approach doesn't work, try another.** You have plenty of time and turns. If you hit a wall, step back, re-read the issue, and try a different approach. Do NOT give up. Explore at least 2-3 different strategies before concluding something cannot be done.

4. **Verify your work.**
   - Run the project's test suite (check package.json scripts, Makefile, pytest.ini, Cargo.toml, go.mod).
   - Run the linter if configured.
   - If you introduced new behavior, add tests that cover it.
   - Make sure your changes actually address every part of the issue description.

5. **Stage your changes.** Run \`git add\` on only the files you intentionally modified. Do NOT stage generated files, lock files (package-lock.json, yarn.lock, Cargo.lock, go.sum), build artifacts, or .env files.

6. **Final check.** Re-read the issue description and verify your solution addresses it completely. Check for any debug code, console.log statements, or TODO comments you may have left.

## Critical rules
- You MUST produce code changes that address the issue. Concluding "already fixed" or "no changes needed" is not acceptable.
- Do NOT commit. The pipeline handles commits and PR creation.
- Do NOT modify files clearly unrelated to the issue.
- Do NOT add unnecessary dependencies.
- If tests existed before and pass, do not remove or skip them.
- If you are struggling, use your remaining turns to keep trying different approaches rather than giving up.

When done, output a structured summary:
**Files modified:** (list each file and what changed)
**How this fixes the issue:** (1-2 sentences connecting your changes to the issue)
**Tests:** (what tests you ran and their results)`;
}

function buildNoChangesRetryPrompt(bounty: Bounty, attempt: number, previousOutput: string): string {
  return `You were asked to solve GitHub issue #${bounty.issueNumber} ("${bounty.title}") in ${bounty.repoOwner}/${bounty.repoName}, but you made ZERO code changes. This is not acceptable — the bounty is confirmed open and unsolved.

## What went wrong on your previous attempt
You concluded no changes were needed or that the issue was already fixed. That conclusion was incorrect. The issue is verified open by the maintainers.

## Your previous output (last 1500 chars)
\`\`\`
${previousOutput.slice(-1500)}
\`\`\`

## What you must do now (attempt ${attempt})
1. Re-read the issue description carefully. Look for subtle details you may have missed.
2. Search the codebase more thoroughly — check open branches, recent commits, and whether the fix was only partially applied.
3. If a previous commit appears to fix it, check whether the fix is actually correct and complete. Look for edge cases, missing test coverage, or incomplete implementations.
4. You MUST make code changes. Even if you believe the core fix exists, there is always something to improve: add missing tests, fix edge cases, improve error handling, or update documentation.
5. Stage your changes with \`git add\`.
6. Do NOT commit.`;
}

/**
 * Spawn Claude CLI with stream-json output for rich terminal display.
 * Saves raw JSON events to {logFile}.jsonl for the dashboard viewer.
 * Returns the accumulated text output when the process exits.
 */
async function spawnClaude(
  prompt: string,
  repoPath: string,
  logFile: string,
  timeoutMs: number,
  onMetrics?: (metrics: { linesOutput: number; lastActivity: string }) => void,
): Promise<string> {
  const config = getConfig();
  const eventsFile = logFile.replace(/\.log$/, ".jsonl");

  return new Promise<string>((resolvePromise, reject) => {
    const claudePath = process.env.CLAUDE_PATH || "claude";
    const child = spawn(
      claudePath,
      [
        "--print",
        "--verbose",
        "--output-format", "stream-json",
        "--dangerously-skip-permissions",
        "--model",
        config.CLAUDE_MODEL,
        "--max-turns",
        String(config.MAX_TURNS),
        "--effort", "high",
        "-",
      ],
      {
        cwd: repoPath,
        env: getClaudeEnv(),
        stdio: ["pipe", "pipe", "pipe"],
      },
    );

    activeChild = child;

    // Pipe the prompt via stdin to avoid ARG_MAX limits on large issue bodies
    child.stdin.write(prompt);
    child.stdin.end();

    let textOutput = "";
    let resultText = ""; // Text from the final result event (preferred)
    let linesOutput = 0;
    let chunksSinceMetrics = 0;
    let lineBuf = "";

    const onStdout = async (chunk: Buffer) => {
      const raw = chunk.toString();
      lineBuf += raw;

      // stream-json emits one JSON object per line
      const lines = lineBuf.split("\n");
      lineBuf = lines.pop() ?? "";

      for (const line of lines) {
        if (!line.trim()) continue;
        linesOutput++;
        chunksSinceMetrics++;

        // Write raw JSON event to .jsonl for the rich dashboard viewer
        try {
          await appendFile(eventsFile, line + "\n");
        } catch {}

        // Extract text content for the return value
        try {
          const event = JSON.parse(line);
          if (event.type === "assistant" && event.message?.content) {
            const texts = event.message.content
              .filter((c: any) => c.type === "text")
              .map((c: any) => c.text);
            textOutput += texts.join("");
          }
          if (event.type === "result" && typeof event.result === "string") {
            resultText = event.result;
          }
        } catch {}
      }

      if (onMetrics && chunksSinceMetrics >= 5) {
        chunksSinceMetrics = 0;
        onMetrics({ linesOutput, lastActivity: new Date().toISOString() });
      }
    };

    const onStderr = async (chunk: Buffer) => {
      const text = chunk.toString();
      try {
        await appendFile(logFile, text);
      } catch {}
    };

    child.stdout.on("data", onStdout);
    child.stderr.on("data", onStderr);

    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error(`Claude solver timed out after ${config.SOLVE_TIMEOUT_MINUTES} minutes`));
    }, timeoutMs);

    child.on("error", (err) => {
      clearTimeout(timer);
      activeChild = null;
      reject(err);
    });

    child.on("close", async (code) => {
      clearTimeout(timer);
      activeChild = null;

      // Process any remaining buffered data
      if (lineBuf.trim()) {
        try { await appendFile(eventsFile, lineBuf + "\n"); } catch {}
        try {
          const event = JSON.parse(lineBuf);
          if (event.type === "result" && typeof event.result === "string") {
            resultText = event.result;
          }
        } catch {}
      }

      await appendFile(logFile, `\n[${new Date().toISOString()}] Process exited with code ${code}\n`).catch(() => {});
      if (code === 0) {
        // Prefer the result event's text (complete final output) over accumulated text
        resolvePromise(resultText || textOutput);
      } else {
        reject(new Error(`Claude CLI exited with code ${code}`));
      }
    });
  });
}

const MAX_NO_CHANGES_RETRIES = 2;

/**
 * Run Claude Code solver with streaming output to a log file.
 * If the agent produces no changes, retries with a stronger prompt.
 */
export async function runClaudeSolver(
  bounty: Bounty,
  repoPath: string,
  trigger?: "auto" | "manual",
): Promise<SolveResult> {
  const config = getConfig();
  const [issueBody, issueComments] = await Promise.all([
    fetchLatestIssueBody(bounty),
    fetchIssueComments(bounty),
  ]);
  const prompt = await buildPrompt(bounty, issueBody, issueComments);
  const timeoutMs = config.SOLVE_TIMEOUT_MINUTES * 60 * 1000;

  log.info(
    { bountyId: bounty.id, repo: `${bounty.repoOwner}/${bounty.repoName}` },
    "Starting Claude Code solver",
  );

  await generateCodebaseContext(repoPath);

  const logDir = getLogDir();
  await mkdir(logDir, { recursive: true });
  const logFile = join(logDir, `${bounty.id}.log`);
  const eventsFile = join(logDir, `${bounty.id}.jsonl`);
  await writeFile(logFile, `[${new Date().toISOString()}] Solver started for ${bounty.repoOwner}/${bounty.repoName}#${bounty.issueNumber}\n`, "utf-8");
  await writeFile(eventsFile, "", "utf-8"); // Clear previous events

  await writeSolverStatus({
    active: true,
    trigger,
    bountyId: bounty.id,
    repo: `${bounty.repoOwner}/${bounty.repoName}`,
    issueNumber: bounty.issueNumber,
    title: bounty.title,
    rewardCents: bounty.rewardCents,
    stage: "solving",
    startedAt: new Date().toISOString(),
    timeoutMinutes: config.SOLVE_TIMEOUT_MINUTES,
  });

  try {
    // spawnClaude sets activeChild, so we update status with PID after first chunk
    const updatePid = async () => {
      const pid = getActiveChildPid();
      if (pid) {
        await writeSolverStatus({
          active: true,
          trigger,
          bountyId: bounty.id,
          repo: `${bounty.repoOwner}/${bounty.repoName}`,
          issueNumber: bounty.issueNumber,
          title: bounty.title,
          rewardCents: bounty.rewardCents,
          stage: "solving",
          startedAt: new Date().toISOString(),
          timeoutMinutes: config.SOLVE_TIMEOUT_MINUTES,
          pid,
        });
      }
    };
    // Small delay to let spawn set the PID
    setTimeout(updatePid, 500);

    const statusBase = {
      active: true as const,
      trigger,
      bountyId: bounty.id,
      repo: `${bounty.repoOwner}/${bounty.repoName}`,
      issueNumber: bounty.issueNumber,
      title: bounty.title,
      rewardCents: bounty.rewardCents,
      stage: "solving",
      startedAt: new Date().toISOString(),
      timeoutMinutes: config.SOLVE_TIMEOUT_MINUTES,
    };
    const onMetrics = (metrics: { linesOutput: number; lastActivity: string }) => {
      writeSolverStatus({ ...statusBase, ...metrics }).catch(() => {});
    };

    let currentOutput = await spawnClaude(prompt, repoPath, logFile, timeoutMs, onMetrics);

    // Check for changes, retrying with a stronger prompt if none were made
    for (let attempt = 0; attempt <= MAX_NO_CHANGES_RETRIES; attempt++) {
      const { stdout: diffStat } = await execFileAsync(
        "git", ["diff", "--stat", "HEAD"], { cwd: repoPath },
      );
      const { stdout: stagedStat } = await execFileAsync(
        "git", ["diff", "--staged", "--stat"], { cwd: repoPath },
      );

      if (diffStat.trim().length > 0 || stagedStat.trim().length > 0) {
        break; // Agent made changes — proceed
      }

      if (attempt === MAX_NO_CHANGES_RETRIES) {
        log.warn({ bountyId: bounty.id }, "Claude made no changes after retries");
        await clearSolverStatus();
        return {
          success: false,
          changesDescription: currentOutput,
          filesChanged: [],
          testsPassed: false,
          error: "No changes were made",
        };
      }

      log.warn(
        { bountyId: bounty.id, attempt: attempt + 1 },
        "Claude made no changes, retrying with stronger prompt",
      );
      await appendFile(logFile, `\n[${new Date().toISOString()}] No changes detected — retrying (attempt ${attempt + 2})\n`).catch(() => {});

      const retryPrompt = buildNoChangesRetryPrompt(bounty, attempt + 2, currentOutput);
      currentOutput = await spawnClaude(retryPrompt, repoPath, logFile, timeoutMs);
    }

    // Get list of changed files
    const { stdout: filesOutput } = await execFileAsync(
      "git", ["diff", "--name-only", "HEAD"], { cwd: repoPath },
    );
    const { stdout: stagedFilesOutput } = await execFileAsync(
      "git", ["diff", "--staged", "--name-only"], { cwd: repoPath },
    );
    const filesChanged = [
      ...new Set([
        ...filesOutput.trim().split("\n").filter((f) => f.length > 0),
        ...stagedFilesOutput.trim().split("\n").filter((f) => f.length > 0),
      ]),
    ];

    log.info(
      { bountyId: bounty.id, filesChanged: filesChanged.length },
      "Claude solver completed",
    );

    await clearSolverStatus();

    return {
      success: true,
      changesDescription: currentOutput.slice(-2000),
      filesChanged,
      testsPassed: false,
    };
  } catch (err: any) {
    log.error({ err, bountyId: bounty.id }, "Claude solver failed");
    await appendFile(logFile, `\n[${new Date().toISOString()}] ERROR: ${err.message}\n`).catch(() => {});
    await clearSolverStatus();
    return {
      success: false,
      changesDescription: "",
      filesChanged: [],
      testsPassed: false,
      error: err.message ?? String(err),
    };
  }
}
