import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createLogger } from "./logger";

const execFileAsync = promisify(execFile);
const log = createLogger("git-utils");

/** Files and patterns that should never be staged in a PR. */
export const EXCLUDE_PATTERNS = [
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

/** Returns true if the file matches any exclude pattern. */
function isExcluded(file: string): boolean {
  return EXCLUDE_PATTERNS.some((pattern) => {
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
}

/**
 * Stage only intentionally modified files, excluding artifacts and lock files.
 * Returns the list of staged file paths.
 */
export async function stageFilteredChanges(repoPath: string): Promise<string[]> {
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

  const filesToStage = allFiles.filter((file) => !isExcluded(file));

  if (filesToStage.length === 0) {
    throw new Error("No files to stage after filtering out artifacts and lock files");
  }

  // Unstage any excluded files that Claude may have staged
  const excludedFiles = allFiles.filter((f) => !filesToStage.includes(f));
  if (excludedFiles.length > 0) {
    await execFileAsync("git", ["reset", "HEAD", "--", ...excludedFiles], { cwd: repoPath }).catch(() => {});
  }

  // Stage the good files
  await execFileAsync("git", ["add", ...filesToStage], { cwd: repoPath });

  log.info(
    { staged: filesToStage.length, excluded: allFiles.length - filesToStage.length },
    "Staged changes (excluded artifacts/lock files)",
  );

  return filesToStage;
}
