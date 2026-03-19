import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { existsSync } from "node:fs";
import { resolve, join } from "node:path";
import { rm, mkdir, writeFile, appendFile } from "node:fs/promises";
import { eq } from "drizzle-orm";
import { getConfig, getDb, schema, createLogger, recordReviewFix, stageFilteredChanges } from "@algora/core";
import type { PendingReview } from "./review-watcher";
import { getPrDiff } from "./responder";

const execFileAsync = promisify(execFile);
const log = createLogger("review-fixer");

function getWorkspacePath(owner: string, repo: string): string {
  return resolve(getConfig().WORKSPACE_DIR, owner, repo);
}

/**
 * Count how many fix attempts have already been made for this bounty.
 */
function getFixAttemptCount(bountyId: string): number {
  const db = getDb();
  const responded = db
    .select()
    .from(schema.prReviews)
    .where(eq(schema.prReviews.bountyId, bountyId))
    .all()
    .filter((r) => r.respondedAt !== null);
  return responded.length;
}

/**
 * Clone the fork and check out the existing PR branch so we can push fixes.
 */
async function checkoutPrBranch(
  owner: string,
  repo: string,
  prNumber: number,
): Promise<{ repoPath: string; branch: string }> {
  const wsPath = getWorkspacePath(owner, repo);

  // Clean previous workspace
  if (existsSync(wsPath)) {
    await rm(wsPath, { recursive: true, force: true });
  }
  await mkdir(resolve(wsPath, ".."), { recursive: true });

  // Get the PR's head ref (fork owner and branch)
  const { stdout: prJson } = await execFileAsync("gh", [
    "pr", "view", String(prNumber),
    "--repo", `${owner}/${repo}`,
    "--json", "headRefName,headRepository,headRepositoryOwner",
  ], { timeout: 15_000 });

  const prInfo = JSON.parse(prJson);
  const branch = prInfo.headRefName;
  const forkOwner = prInfo.headRepositoryOwner?.login;
  const forkRepo = prInfo.headRepository?.name ?? repo;

  const cloneUrl = `https://github.com/${forkOwner}/${forkRepo}.git`;

  log.info({ cloneUrl, branch }, "Cloning fork and checking out PR branch");

  await execFileAsync("git", ["clone", "--depth", "50", "-b", branch, cloneUrl, wsPath], {
    timeout: 120_000,
  });

  // Add upstream remote
  await execFileAsync("git", ["remote", "add", "upstream", `https://github.com/${owner}/${repo}.git`], {
    cwd: wsPath,
  });

  return { repoPath: wsPath, branch };
}

/**
 * Run Claude to fix specific review feedback, then push the fix.
 */
export async function fixReviewFeedback(
  review: PendingReview,
  allReviewComments: PendingReview[],
): Promise<boolean> {
  const config = getConfig();
  const db = getDb();

  // Check fix attempt limit
  const attempts = getFixAttemptCount(review.bountyId);
  if (attempts >= config.MAX_REVIEW_FIX_ATTEMPTS) {
    log.info(
      { bountyId: review.bountyId, attempts },
      "Max review fix attempts reached, skipping auto-fix",
    );
    return false;
  }

  const bounty = db
    .select()
    .from(schema.bounties)
    .where(eq(schema.bounties.id, review.bountyId))
    .get();

  if (!bounty || !bounty.prNumber) return false;

  log.info(
    { bountyId: review.bountyId, prNumber: bounty.prNumber, reviewer: review.author },
    "Attempting to fix review feedback",
  );

  let repoPath: string;
  let branch: string;

  try {
    ({ repoPath, branch } = await checkoutPrBranch(
      review.repoOwner,
      review.repoName,
      bounty.prNumber,
    ));
  } catch (err: any) {
    log.error({ err }, "Failed to checkout PR branch for review fix");
    return false;
  }

  // Gather all unaddressed review comments for context
  const reviewContext = allReviewComments
    .filter((r) => r.bountyId === review.bountyId)
    .map((r) => `**@${r.author}:** ${r.commentBody}`)
    .join("\n\n");

  // Get the current diff for context
  let prDiff = "";
  try {
    prDiff = await getPrDiff(review.repoOwner, review.repoName, bounty.prNumber);
  } catch {
    log.debug("Could not fetch PR diff for fix context");
  }

  const prompt = `You are fixing code review feedback on a pull request for GitHub issue #${bounty.issueNumber} in ${review.repoOwner}/${review.repoName}.

## Original Issue: ${bounty.title}
${bounty.body ?? "(no body)"}

## Current PR Diff
\`\`\`
${prDiff.slice(0, 10000)}
\`\`\`

## Review Feedback to Address
${reviewContext}

## Instructions
1. Read the review comments carefully. Understand exactly what the reviewer is asking for.
2. Make the minimum changes needed to address ALL review feedback.
3. Run tests to verify your changes don't break anything.
4. Stage your changes with \`git add\` (only modified files, no lock files or artifacts).
5. Do NOT commit — the pipeline handles that.

## Critical rules
- Address every point raised by the reviewer
- Do NOT rewrite the entire solution — make targeted fixes only
- Match the existing code style exactly
- Do NOT add unnecessary changes beyond what was requested`;

  const timeoutMs = Math.min(config.SOLVE_TIMEOUT_MINUTES, 15) * 60 * 1000;

  try {
    const claudePath = process.env.CLAUDE_PATH || "claude";

    const stdout = await new Promise<string>((resolvePromise, reject) => {
      const child = spawn(
        claudePath,
        [
          "--print",
          "--dangerously-skip-permissions",
          "--model", config.CLAUDE_MODEL,
          "--max-turns", String(Math.min(config.MAX_TURNS, 30)),
          "-", // read prompt from stdin
        ],
        {
          cwd: repoPath,
          env: (() => {
            const env = { ...process.env };
            if (config.CLAUDE_BACKEND === "cli") delete env.ANTHROPIC_API_KEY;
            return env;
          })(),
          stdio: ["pipe", "pipe", "pipe"],
        },
      );

      // Pipe prompt via stdin to avoid ARG_MAX limits on large diffs
      child.stdin.write(prompt);
      child.stdin.end();

      let output = "";
      child.stdout.on("data", (chunk: Buffer) => { output += chunk.toString(); });
      child.stderr.on("data", (chunk: Buffer) => { output += chunk.toString(); });

      const timer = setTimeout(() => {
        child.kill("SIGTERM");
        reject(new Error("Review fix timed out"));
      }, timeoutMs);

      child.on("error", (err) => { clearTimeout(timer); reject(err); });
      child.on("close", (code) => {
        clearTimeout(timer);
        code === 0 ? resolvePromise(output) : reject(new Error(`Claude exited with code ${code}`));
      });
    });

    // Check if changes were made
    const { stdout: diffStat } = await execFileAsync("git", ["diff", "--stat", "HEAD"], { cwd: repoPath });
    const { stdout: stagedStat } = await execFileAsync("git", ["diff", "--staged", "--stat"], { cwd: repoPath });
    const hasChanges = diffStat.trim().length > 0 || stagedStat.trim().length > 0;

    if (!hasChanges) {
      log.warn({ bountyId: review.bountyId }, "Review fix made no changes");
      await recordReviewFix({
        bountyId: review.bountyId,
        repo: `${review.repoOwner}/${review.repoName}`,
        reviewComment: review.commentBody.slice(0, 200),
        fixAttempted: true,
        fixSucceeded: false,
        timestamp: new Date().toISOString(),
      });
      return false;
    }

    // Stage only intentional changes (no lock files, artifacts, etc.)
    await stageFilteredChanges(repoPath);

    const commitMsg = `fix: address review feedback on #${bounty.issueNumber}`;
    await execFileAsync("git", ["commit", "-m", commitMsg], { cwd: repoPath });
    await execFileAsync("git", ["push", "origin", branch], { cwd: repoPath, timeout: 60_000 });

    log.info({ bountyId: review.bountyId, branch }, "Pushed review fix");

    await recordReviewFix({
      bountyId: review.bountyId,
      repo: `${review.repoOwner}/${review.repoName}`,
      reviewComment: review.commentBody.slice(0, 200),
      fixAttempted: true,
      fixSucceeded: true,
      timestamp: new Date().toISOString(),
    });

    return true;
  } catch (err: any) {
    log.error({ err, bountyId: review.bountyId }, "Review fix failed");
    await recordReviewFix({
      bountyId: review.bountyId,
      repo: `${review.repoOwner}/${review.repoName}`,
      reviewComment: review.commentBody.slice(0, 200),
      fixAttempted: true,
      fixSucceeded: false,
      timestamp: new Date().toISOString(),
    });
    return false;
  } finally {
    // Cleanup workspace
    const wsPath = getWorkspacePath(review.repoOwner, review.repoName);
    await rm(wsPath, { recursive: true, force: true }).catch(() => {});
  }
}
