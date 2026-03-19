import { eq, sql, desc } from "drizzle-orm";
import { writeFile, appendFile, mkdir } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join } from "node:path";
import { getDb, schema, getConfig, createLogger, isTransientError, generateTraceId, classifyError, recordSolveOutcome, type Bounty } from "@algora/core";
import { cloneRepo, createBranch, cleanupWorkspace } from "./repo-manager";
import { postAttempt, postImplementationPlan } from "./attempt";
import { runClaudeSolver } from "./claude-runner";
import { validateChanges } from "./validator";
import { commitAndPush, createPullRequest } from "./pr-creator";
import { clearSolverStatus } from "./status";

const log = createLogger("solver");

let solving = false;

export async function processNextBounty(): Promise<void> {
  if (solving) {
    log.debug("Solver is busy, skipping");
    return;
  }

  const db = getDb();
  const config = getConfig();

  // Global mutex: don't solve while analyzer is active
  const analyzing = db
    .select()
    .from(schema.bounties)
    .where(eq(schema.bounties.status, "analyzing"))
    .limit(1)
    .get();

  if (analyzing) {
    log.debug("Analyzer is active, skipping solve");
    return;
  }

  // Find the next selected bounty (or approved bounty if approval required)
  // Prioritize by priority score (reward × feasibility / competition)
  const next = db
    .select()
    .from(schema.bounties)
    .where(eq(schema.bounties.status, config.REQUIRE_APPROVAL ? "attempting" : "selected"))
    .orderBy(desc(schema.bounties.priorityScore))
    .limit(1)
    .get();

  if (!next) {
    log.debug("No bounties ready to solve");
    return;
  }

  solving = true;

  try {
    await solveBounty(next, "auto");
  } finally {
    solving = false;
  }
}

function getLogFile(bountyId: string): string {
  const root = process.env.PROJECT_ROOT || process.cwd();
  return join(root, "data", "logs", `${bountyId}.log`);
}

async function appendLog(bountyId: string, message: string): Promise<void> {
  try {
    const logFile = getLogFile(bountyId);
    await appendFile(logFile, `[${new Date().toISOString()}] ${message}\n`);
  } catch {}
}

export async function solveBounty(bounty: Bounty, trigger?: "auto" | "manual"): Promise<void> {
  const db = getDb();
  const config = getConfig();
  const startTime = Date.now();

  const traceId = generateTraceId();

  log.info(
    {
      traceId,
      id: bounty.id,
      title: bounty.title,
      reward: `$${(bounty.rewardCents / 100).toFixed(2)}`,
    },
    "Starting bounty solve",
  );

  // Create log file early so repo setup failures are captured
  const logDir = join(process.env.PROJECT_ROOT || process.cwd(), "data", "logs");
  await mkdir(logDir, { recursive: true });
  const logFile = getLogFile(bounty.id);
  await writeFile(logFile, `[${new Date().toISOString()}] Starting solve for ${bounty.repoOwner}/${bounty.repoName}#${bounty.issueNumber} ($${(bounty.rewardCents / 100).toFixed(2)})\n`, "utf-8");

  // Record pipeline run
  const run = db
    .insert(schema.pipelineRuns)
    .values({
      traceId,
      bountyId: bounty.id,
      stage: "solve",
      status: "running",
      startedAt: new Date(),
    })
    .returning()
    .get();

  try {
    // 1. Clone repo (always fresh — previous workspace is cleaned)
    await appendLog(bounty.id, "Forking and cloning repository...");
    const repoPath = await cloneRepo(bounty.repoOwner, bounty.repoName);
    await appendLog(bounty.id, `Cloned to ${repoPath}`);

    await appendLog(bounty.id, "Creating feature branch...");
    const branch = await createBranch(
      repoPath,
      bounty.issueNumber,
      bounty.title,
    );
    await appendLog(bounty.id, `Created branch: ${branch}`);

    // 2. Post /attempt if we haven't yet
    if (bounty.status !== "attempting") {
      await appendLog(bounty.id, "Posting /attempt comment...");
      await postAttempt(
        bounty.repoOwner,
        bounty.repoName,
        bounty.issueNumber,
      );
    }

    // 2b. Post implementation plan if the issue requires it
    if (bounty.analysisNotes) {
      try {
        const notes = JSON.parse(bounty.analysisNotes);
        if (notes.requiresPlanComment && notes.approach) {
          await appendLog(bounty.id, "Posting implementation plan comment...");
          await postImplementationPlan(
            bounty.repoOwner,
            bounty.repoName,
            bounty.issueNumber,
            notes.approach,
          );
        }
      } catch {
        // analysisNotes might not be valid JSON — skip
      }
    }

    // 2c. Verify the GitHub issue is still open before investing solve time
    try {
      const execFileAsync = promisify(execFile);
      const { stdout } = await execFileAsync("gh", [
        "issue", "view", String(bounty.issueNumber),
        "--repo", `${bounty.repoOwner}/${bounty.repoName}`,
        "--json", "state",
      ]);
      const issueState = JSON.parse(stdout).state;
      if (issueState !== "OPEN") {
        log.info({ id: bounty.id, state: issueState }, "Issue no longer open — marking as removed");
        await appendLog(bounty.id, `Issue is ${issueState}, skipping solve`);
        db.update(schema.bounties)
          .set({ status: "removed", updatedAt: new Date() })
          .where(eq(schema.bounties.id, bounty.id))
          .run();
        await cleanupWorkspace(bounty.repoOwner, bounty.repoName);
        db.update(schema.pipelineRuns)
          .set({ status: "failed", errorCategory: "permanent", errorMessage: "Issue closed", completedAt: new Date(), durationMs: Date.now() - startTime })
          .where(eq(schema.pipelineRuns.id, run.id))
          .run();
        await recordSolveOutcome({
          bountyId: bounty.id,
          repo: `${bounty.repoOwner}/${bounty.repoName}`,
          language: bounty.language,
          rewardCents: bounty.rewardCents,
          feasibilityScore: bounty.feasibilityScore,
          outcome: "failed",
          errorSummary: "Issue closed before solve started",
          durationMs: Date.now() - startTime,
          timestamp: new Date().toISOString(),
        });
        return;
      }
    } catch (err) {
      log.warn({ err, id: bounty.id }, "Failed to check issue state — proceeding with solve");
    }

    db.update(schema.bounties)
      .set({ status: "solving", updatedAt: new Date() })
      .where(eq(schema.bounties.id, bounty.id))
      .run();

    // 3. Run Claude Code
    let result = await runClaudeSolver(bounty, repoPath, trigger);

    // 4. Validate (with targeted retry loop)
    if (result.success) {
      let validation = await validateChanges(repoPath);
      let retryAttempt = 0;

      while (!validation.passed && retryAttempt < config.MAX_RETRY_ATTEMPTS) {
        retryAttempt++;
        log.warn({ attempt: retryAttempt, errors: validation.errors }, "Validation failed, asking Claude to fix specific errors");

        // Build a targeted fix prompt instead of re-running the full solver
        const fixPrompt = `The previous changes for issue #${bounty.issueNumber} ("${bounty.title}") caused validation failures. Fix ONLY these specific errors — do not rewrite the solution.

## Errors to fix (attempt ${retryAttempt}/${config.MAX_RETRY_ATTEMPTS})

${validation.errors.map((e: string) => `- ${e}`).join("\n")}

${validation.testOutput ? `### Test output (last 3000 chars)\n\`\`\`\n${validation.testOutput.slice(-3000)}\n\`\`\`` : ""}

${validation.lintOutput ? `### Lint output (last 2000 chars)\n\`\`\`\n${validation.lintOutput.slice(-2000)}\n\`\`\`` : ""}

## Instructions
1. Read the error output carefully to understand what's failing.
2. Make the minimum changes needed to fix these specific errors.
3. Run the tests/linter again to verify.
4. Stage your changes with \`git add\` (only modified files, no lock files or artifacts).
5. Do NOT commit.`;

        result = await runClaudeSolver(
          { ...bounty, body: fixPrompt },
          repoPath,
          trigger,
        );

        if (!result.success) break;
        validation = await validateChanges(repoPath);
      }

      result.testsPassed = validation.passed;
      if (!validation.passed && result.success) {
        log.warn({ errors: validation.errors }, "Validation still failing after retries, proceeding anyway");
      }
    }

    if (!result.success) {
      // Check if Claude determined the issue is already resolved
      const alreadyResolved = result.error?.includes("No changes") &&
        /already\s+(been\s+)?(fixed|resolved|merged|addressed|closed)/i.test(result.changesDescription);

      const outcome = alreadyResolved
        ? "no_changes" as const
        : result.error?.includes("No changes")
          ? "no_changes" as const
          : result.error?.includes("timeout") || result.error?.includes("SIGTERM")
            ? "timeout" as const
            : "failed" as const;

      await recordSolveOutcome({
        bountyId: bounty.id,
        repo: `${bounty.repoOwner}/${bounty.repoName}`,
        language: bounty.language,
        rewardCents: bounty.rewardCents,
        feasibilityScore: bounty.feasibilityScore,
        outcome,
        errorSummary: result.error?.slice(0, 500),
        durationMs: Date.now() - startTime,
        timestamp: new Date().toISOString(),
      });

      // If already resolved, mark as failed permanently so it doesn't get re-queued
      if (alreadyResolved) {
        await appendLog(bounty.id, "Issue appears already resolved — marking as failed");
        db.update(schema.bounties)
          .set({ status: "failed", retryCount: config.MAX_RETRY_ATTEMPTS, updatedAt: new Date() })
          .where(eq(schema.bounties.id, bounty.id))
          .run();
        db.update(schema.pipelineRuns)
          .set({
            status: "failed",
            completedAt: new Date(),
            durationMs: Date.now() - run.startedAt.getTime(),
            logs: "Issue already resolved",
            errorCategory: "no_changes",
            errorMessage: "Issue appears already resolved",
          })
          .where(eq(schema.pipelineRuns.id, run.id))
          .run();
        return; // Skip the throw — handled here
      }

      throw new Error(result.error ?? "Solver produced no changes");
    }

    // 5. Commit and push — if this fails, preserve workspace for manual recovery
    try {
      await commitAndPush(repoPath, bounty);
    } catch (prErr: any) {
      log.error({ err: prErr, bountyId: bounty.id, repoPath }, "PR pipeline failed — PRESERVING workspace for manual recovery");
      await appendLog(bounty.id, `PR PIPELINE FAILED (workspace preserved at ${repoPath}): ${prErr.message}`);
      throw prErr;
    }

    // 6. Create PR
    const pr = await createPullRequest(
      repoPath,
      bounty,
      result.changesDescription,
    );

    // 7. Update bounty
    db.update(schema.bounties)
      .set({
        status: "pr_created",
        prUrl: pr.url,
        prNumber: pr.number,
        updatedAt: new Date(),
      })
      .where(eq(schema.bounties.id, bounty.id))
      .run();

    // Update pipeline run
    db.update(schema.pipelineRuns)
      .set({
        status: "success",
        completedAt: new Date(),
        durationMs: Date.now() - run.startedAt.getTime(),
        logs: result.changesDescription.slice(-5000),
      })
      .where(eq(schema.pipelineRuns.id, run.id))
      .run();

    // Record success
    await recordSolveOutcome({
      bountyId: bounty.id,
      repo: `${bounty.repoOwner}/${bounty.repoName}`,
      language: bounty.language,
      rewardCents: bounty.rewardCents,
      feasibilityScore: bounty.feasibilityScore,
      outcome: "success",
      durationMs: Date.now() - startTime,
      timestamp: new Date().toISOString(),
    });

    log.info(
      { bountyId: bounty.id, prUrl: pr.url },
      "Bounty solved and PR created",
    );
  } catch (err: any) {
    await appendLog(bounty.id, `ERROR: ${err.message ?? String(err)}`);
    const retries = (bounty.retryCount ?? 0) + 1;
    const retryStatus = bounty.status === "attempting" ? "attempting" : "selected";

    if (isTransientError(err) && retries < config.MAX_RETRY_ATTEMPTS) {
      log.warn(
        { err, bountyId: bounty.id, retryCount: retries },
        "Solve hit transient error, returning to queue for retry",
      );
      db.update(schema.bounties)
        .set({
          status: retryStatus,
          retryCount: retries,
          updatedAt: new Date(),
        })
        .where(eq(schema.bounties.id, bounty.id))
        .run();
    } else {
      log.error(
        { err, bountyId: bounty.id, transient: isTransientError(err), retryCount: retries },
        "Solve failed permanently",
      );
      db.update(schema.bounties)
        .set({ status: "failed", retryCount: retries, updatedAt: new Date() })
        .where(eq(schema.bounties.id, bounty.id))
        .run();
    }

    const classified = classifyError(err);
    db.update(schema.pipelineRuns)
      .set({
        status: "failed",
        completedAt: new Date(),
        durationMs: Date.now() - run.startedAt.getTime(),
        logs: err.message,
        errorCategory: classified.category,
        errorMessage: classified.message,
      })
      .where(eq(schema.pipelineRuns.id, run.id))
      .run();
  } finally {
    // Clean up workspace — but only if the solve itself failed or PR was created.
    // If the solver succeeded but the PR pipeline threw, the workspace is preserved
    // so the work can be manually recovered.
    const currentStatus = db.select().from(schema.bounties).where(eq(schema.bounties.id, bounty.id)).get();
    const prPipelineFailed = currentStatus?.status === "failed" || currentStatus?.status === "selected";
    const solverProducedChanges = currentStatus?.status !== "solving"; // still solving = never got past solver

    // Preserve workspace only when solver succeeded but PR pipeline failed
    const shouldPreserve = prPipelineFailed && solverProducedChanges;
    if (shouldPreserve) {
      const wsPath = join(process.env.PROJECT_ROOT || process.cwd(), ".workspaces", bounty.repoOwner, bounty.repoName);
      log.warn({ bountyId: bounty.id, workspace: wsPath }, "Preserving workspace — solver succeeded but PR pipeline failed");
    } else {
      await cleanupWorkspace(bounty.repoOwner, bounty.repoName).catch((err) =>
        log.warn({ err }, "Failed to clean up workspace"),
      );
    }
  }
}

export async function approveBounty(bountyId: string): Promise<void> {
  const db = getDb();
  db.update(schema.bounties)
    .set({ status: "attempting", attemptedAt: new Date(), updatedAt: new Date() })
    .where(eq(schema.bounties.id, bountyId))
    .run();
  log.info({ bountyId }, "Bounty approved for solving");
}

/**
 * Force-stop the active solver: kills the Claude process, resets in-memory
 * flag, clears solver status file, and resets the stuck bounty in the DB.
 * Designed to be called from the dashboard for immediate recovery.
 */
export async function forceStopSolver(): Promise<{ killed: boolean; resetBountyId: string | null }> {
  const { killActiveProcess } = await import("./claude-runner");
  const killed = killActiveProcess();

  // Reset the in-memory mutex so new solves can start
  solving = false;

  // Find and reset any bounty stuck in solving/attempting
  const db = getDb();
  const stuck = db
    .select()
    .from(schema.bounties)
    .where(sql`${schema.bounties.status} IN ('solving', 'attempting')`)
    .all();

  let resetBountyId: string | null = null;
  for (const b of stuck) {
    db.update(schema.bounties)
      .set({ status: "selected", updatedAt: new Date() })
      .where(eq(schema.bounties.id, b.id))
      .run();
    resetBountyId = b.id;
    log.info({ bountyId: b.id }, "Force-stop: reset stuck bounty to selected");
  }

  // Mark any running pipeline runs as failed
  db.update(schema.pipelineRuns)
    .set({
      status: "failed",
      completedAt: new Date(),
      errorCategory: "timeout",
      errorMessage: "Force-stopped by user from dashboard",
    })
    .where(eq(schema.pipelineRuns.status, "running" as any))
    .run();

  // Clear the solver status file
  await clearSolverStatus();

  // Clean up any active workspace
  for (const b of stuck) {
    await cleanupWorkspace(b.repoOwner, b.repoName).catch(() => {});
  }

  return { killed, resetBountyId };
}

export { cloneRepo, createBranch, cleanupWorkspace } from "./repo-manager";
export { runClaudeSolver, killActiveProcess } from "./claude-runner";
export { validateChanges } from "./validator";
export { readSolverStatus, clearSolverStatus, type SolverStatus } from "./status";
