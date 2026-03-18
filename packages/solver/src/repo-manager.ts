import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { resolve, join } from "node:path";
import { existsSync } from "node:fs";
import { rm, mkdir } from "node:fs/promises";
import { getConfig, createLogger } from "@algora/core";

const execFileAsync = promisify(execFile);
const log = createLogger("repo-manager");

function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 40);
}

export function getWorkspacePath(owner: string, repo: string): string {
  return resolve(getConfig().WORKSPACE_DIR, owner, repo);
}

/**
 * Fork the repo on GitHub (idempotent — gh repo fork is a no-op if already forked).
 * Returns the fork's clone URL (e.g. https://github.com/youruser/repo.git).
 */
async function ensureFork(owner: string, repo: string): Promise<string> {
  log.info({ repo: `${owner}/${repo}` }, "Ensuring fork exists");

  // gh repo fork is idempotent — if already forked it just prints the existing fork
  const { stderr } = await execFileAsync(
    "gh",
    ["repo", "fork", `${owner}/${repo}`, "--clone=false"],
    { timeout: 60_000 },
  );

  // Get the authenticated user's fork URL
  const { stdout: forkJson } = await execFileAsync(
    "gh",
    ["repo", "view", `${owner}/${repo}`, "--json", "parent", "--jq", ".parent.owner.login"],
    { timeout: 30_000 },
  ).catch(() => ({ stdout: "" }));

  // Get authenticated user
  const { stdout: viewer } = await execFileAsync(
    "gh",
    ["api", "user", "--jq", ".login"],
    { timeout: 15_000 },
  );
  const username = viewer.trim();

  const forkUrl = `https://github.com/${username}/${repo}.git`;
  log.info({ forkUrl, username }, "Fork ready");
  return forkUrl;
}

export async function cloneRepo(
  owner: string,
  repo: string,
): Promise<string> {
  const wsPath = getWorkspacePath(owner, repo);

  // Always start clean to avoid workspace contamination from previous attempts
  if (existsSync(wsPath)) {
    log.info({ path: wsPath }, "Cleaning up previous workspace");
    await rm(wsPath, { recursive: true, force: true });
  }

  await mkdir(resolve(wsPath, ".."), { recursive: true });

  // Fork the repo first, then clone from the fork
  const forkUrl = await ensureFork(owner, repo);

  log.info({ forkUrl, path: wsPath }, "Cloning fork");
  await execFileAsync("git", ["clone", "--depth", "50", forkUrl, wsPath], {
    timeout: 120_000,
  });

  // Add upstream remote for reference
  const upstreamUrl = `https://github.com/${owner}/${repo}.git`;
  await execFileAsync(
    "git",
    ["remote", "add", "upstream", upstreamUrl],
    { cwd: wsPath },
  );

  // Fetch upstream to ensure we're up to date with the target repo
  await execFileAsync(
    "git",
    ["fetch", "upstream", "--depth", "50"],
    { cwd: wsPath, timeout: 60_000 },
  );

  return wsPath;
}

export async function createBranch(
  repoPath: string,
  issueNumber: number,
  titleSlug: string,
): Promise<string> {
  const branchName = `algora/fix-${issueNumber}-${slugify(titleSlug)}`;

  // Ensure we're on the upstream default branch first
  const { stdout: defaultBranch } = await execFileAsync(
    "git",
    ["symbolic-ref", "refs/remotes/upstream/HEAD", "--short"],
    { cwd: repoPath },
  ).catch(() => ({ stdout: "upstream/main" }));

  const baseBranch = defaultBranch.trim().replace("upstream/", "");

  // Reset to upstream's latest to ensure we're branching from the right place
  await execFileAsync("git", ["checkout", baseBranch], { cwd: repoPath }).catch(
    () => execFileAsync("git", ["checkout", "-b", baseBranch, `upstream/${baseBranch}`], { cwd: repoPath }),
  );
  await execFileAsync(
    "git",
    ["reset", "--hard", `upstream/${baseBranch}`],
    { cwd: repoPath },
  );

  await execFileAsync("git", ["checkout", "-b", branchName], {
    cwd: repoPath,
  });

  log.info({ branch: branchName }, "Created branch");
  return branchName;
}

export async function cleanupWorkspace(
  owner: string,
  repo: string,
): Promise<void> {
  const wsPath = getWorkspacePath(owner, repo);
  if (existsSync(wsPath)) {
    await rm(wsPath, { recursive: true, force: true });
    log.info({ path: wsPath }, "Cleaned up workspace");
  }
}
