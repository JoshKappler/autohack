import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createLogger, runClaude, type Bounty } from "@algora/core";

const execFileAsync = promisify(execFile);
const log = createLogger("pr-creator");

// Files and patterns that should never be staged in a PR
const EXCLUDE_PATTERNS = [
  "package-lock.json",
  "yarn.lock",
  "pnpm-lock.yaml",
  "Cargo.lock",
  "go.sum",
  "poetry.lock",
  "Gemfile.lock",
  ".env",
  ".env.*",
  "CLAUDE.md",
  "node_modules/",
  ".next/",
  "dist/",
  "build/",
  "target/",
  "__pycache__/",
  "*.pyc",
  ".DS_Store",
];

/**
 * Stage only intentionally modified files, excluding artifacts and lock files.
 */
async function stageChanges(repoPath: string): Promise<string[]> {
  // Get list of all changed/new files — check both unstaged, staged, and untracked
  // Claude's solver may have already `git add`-ed files, so we need --staged too
  const { stdout: diffFiles } = await execFileAsync(
    "git", ["diff", "--name-only"], { cwd: repoPath },
  );
  const { stdout: stagedFiles } = await execFileAsync(
    "git", ["diff", "--staged", "--name-only"], { cwd: repoPath },
  );
  const { stdout: untrackedFiles } = await execFileAsync(
    "git", ["ls-files", "--others", "--exclude-standard"], { cwd: repoPath },
  );

  const allFiles = [
    ...new Set([
      ...diffFiles.trim().split("\n").filter((f) => f.length > 0),
      ...stagedFiles.trim().split("\n").filter((f) => f.length > 0),
      ...untrackedFiles.trim().split("\n").filter((f) => f.length > 0),
    ]),
  ];

  // Filter out excluded patterns
  const filesToStage = allFiles.filter((file) => {
    return !EXCLUDE_PATTERNS.some((pattern) => {
      if (pattern.endsWith("/")) {
        return file.startsWith(pattern) || file.includes(`/${pattern}`);
      }
      if (pattern.startsWith("*.")) {
        return file.endsWith(pattern.slice(1));
      }
      if (pattern.includes(".*")) {
        const base = pattern.split(".*")[0];
        return file === base || file.startsWith(`${base}.`);
      }
      return file === pattern || file.endsWith(`/${pattern}`);
    });
  });

  if (filesToStage.length === 0) {
    throw new Error("No files to stage after filtering out artifacts and lock files");
  }

  // Unstage any excluded files that Claude may have staged
  const excludedFiles = allFiles.filter((f) => !filesToStage.includes(f));
  if (excludedFiles.length > 0) {
    await execFileAsync("git", ["reset", "HEAD", "--", ...excludedFiles], { cwd: repoPath }).catch(() => {});
  }

  // Stage the good files (handles both already-staged and unstaged)
  await execFileAsync("git", ["add", ...filesToStage], { cwd: repoPath });

  log.info(
    { staged: filesToStage.length, excluded: allFiles.length - filesToStage.length },
    "Staged changes (excluded artifacts/lock files)",
  );

  return filesToStage;
}

/**
 * Self-review: have Claude review the diff before creating the PR.
 * Returns suggestions or empty string if the diff looks good.
 */
async function selfReviewDiff(repoPath: string, bounty: Bounty): Promise<string | null> {
  try {
    const { stdout: diff } = await execFileAsync(
      "git", ["diff", "--staged"], { cwd: repoPath, maxBuffer: 5 * 1024 * 1024 },
    );

    if (diff.trim().length === 0) return null;

    const prompt = `You are reviewing a code diff before it's submitted as a pull request for GitHub issue #${bounty.issueNumber}: "${bounty.title}"

The diff:
\`\`\`
${diff.slice(0, 8000)}
\`\`\`

Check for these problems ONLY (respond with "LGTM" if none found):
1. Debug/console.log statements left in
2. TODO/FIXME/HACK comments that shouldn't be committed
3. Accidentally deleted code that wasn't related to the issue
4. Obvious logic errors or typos
5. Hardcoded values that should be configurable

If you find issues, list them briefly (one line each). If the diff looks good, respond with just "LGTM".`;

    const review = await runClaude(prompt, { timeoutMs: 60_000 });
    const trimmed = review.trim();

    if (trimmed === "LGTM" || trimmed.toLowerCase().includes("looks good")) {
      log.info("Self-review passed — diff looks clean");
      return null;
    }

    log.warn({ review: trimmed }, "Self-review found potential issues");
    return trimmed;
  } catch (err) {
    log.warn({ err }, "Self-review failed — proceeding anyway");
    return null;
  }
}

/**
 * Generate a clean, structured PR description using Claude instead of
 * dumping raw solver output.
 */
async function generatePrDescription(
  repoPath: string,
  bounty: Bounty,
  rawChangesDescription: string,
): Promise<string> {
  try {
    const { stdout: diff } = await execFileAsync(
      "git", ["diff", "--staged", "--stat"], { cwd: repoPath },
    );

    const prompt = `Write a concise pull request description for GitHub issue #${bounty.issueNumber}: "${bounty.title}"

Changed files:
${diff.slice(0, 2000)}

Solver notes:
${rawChangesDescription.slice(0, 2000)}

Write ONLY the PR body (no title). Use this format:
## Summary
(2-3 sentences explaining what was changed and why)

## Changes
(bulleted list of specific changes, one per file or logical group)

## Testing
(what tests were run/added)

Be concise and professional. Do not mention AI, automation, or bounties in the summary.`;

    const description = await runClaude(prompt, { timeoutMs: 60_000 });
    return description.trim();
  } catch (err) {
    log.warn({ err }, "Failed to generate PR description — using fallback");
    return `## Summary\n\nResolves #${bounty.issueNumber}\n\n${rawChangesDescription.slice(0, 1500)}`;
  }
}

export async function commitAndPush(
  repoPath: string,
  bounty: Bounty,
): Promise<void> {
  // Stage only intentional changes (no lock files, artifacts, etc.)
  await stageChanges(repoPath);

  // Self-review the diff before committing
  const reviewIssues = await selfReviewDiff(repoPath, bounty);
  if (reviewIssues) {
    log.info("Self-review found issues — they've been logged but proceeding with commit");
    // TODO: In the future, we could feed these back to Claude for a fix pass
  }

  // Commit
  const commitMsg = `fix: resolve #${bounty.issueNumber} — ${bounty.title}`;
  await execFileAsync("git", ["commit", "-m", commitMsg], { cwd: repoPath });

  // Push to fork (origin is the fork)
  const { stdout: branch } = await execFileAsync(
    "git",
    ["branch", "--show-current"],
    { cwd: repoPath },
  );

  await execFileAsync(
    "git",
    ["push", "-u", "origin", branch.trim()],
    { cwd: repoPath, timeout: 60_000 },
  );

  log.info({ branch: branch.trim() }, "Pushed changes to fork");
}

export async function createPullRequest(
  repoPath: string,
  bounty: Bounty,
  changesDescription: string,
): Promise<{ url: string; number: number }> {
  const title = `Fix #${bounty.issueNumber}: ${bounty.title}`.slice(0, 70);

  // Generate a clean PR description using Claude
  const description = await generatePrDescription(repoPath, bounty, changesDescription);

  const body = `${description}

---

/claim #${bounty.issueNumber}`;

  // Get the fork owner (authenticated user)
  const { stdout: viewer } = await execFileAsync(
    "gh",
    ["api", "user", "--jq", ".login"],
    { timeout: 15_000 },
  );
  const forkOwner = viewer.trim();

  const { stdout: branch } = await execFileAsync(
    "git",
    ["branch", "--show-current"],
    { cwd: repoPath },
  );

  log.info(
    {
      repo: `${bounty.repoOwner}/${bounty.repoName}`,
      head: `${forkOwner}:${branch.trim()}`,
      title,
    },
    "Creating pull request from fork to upstream",
  );

  // Create PR targeting the upstream repo, from the fork's branch
  const { stdout } = await execFileAsync(
    "gh",
    [
      "pr",
      "create",
      "--repo",
      `${bounty.repoOwner}/${bounty.repoName}`,
      "--head",
      `${forkOwner}:${branch.trim()}`,
      "--title",
      title,
      "--body",
      body,
    ],
    { cwd: repoPath, timeout: 30_000 },
  );

  const prUrl = stdout.trim();

  // Extract PR number from URL
  const prMatch = prUrl.match(/\/pull\/(\d+)/);
  const prNumber = prMatch ? parseInt(prMatch[1], 10) : 0;

  log.info({ prUrl, prNumber }, "Pull request created");
  return { url: prUrl, number: prNumber };
}
