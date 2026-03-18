import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createLogger } from "@algora/core";

const execFileAsync = promisify(execFile);
const log = createLogger("attempt");

export async function postAttempt(
  owner: string,
  repo: string,
  issueNumber: number,
): Promise<void> {
  log.info(
    { repo: `${owner}/${repo}`, issue: issueNumber },
    "Posting /attempt comment",
  );

  await execFileAsync("gh", [
    "issue",
    "comment",
    String(issueNumber),
    "--repo",
    `${owner}/${repo}`,
    "--body",
    `/attempt`,
  ]);

  log.info("Posted /attempt comment successfully");
}

export async function postImplementationPlan(
  owner: string,
  repo: string,
  issueNumber: number,
  approach: string,
): Promise<void> {
  log.info(
    { repo: `${owner}/${repo}`, issue: issueNumber },
    "Posting implementation plan comment",
  );

  const body = `## Implementation Plan\n\n${approach}\n\n---\n*Starting implementation now.*`;

  await execFileAsync("gh", [
    "issue",
    "comment",
    String(issueNumber),
    "--repo",
    `${owner}/${repo}`,
    "--body",
    body,
  ]);

  log.info("Posted implementation plan comment successfully");
}
