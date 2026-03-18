import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { eq } from "drizzle-orm";
import { runClaude, getDb, schema, createLogger } from "@algora/core";
import type { PendingReview } from "./review-watcher";

const execFileAsync = promisify(execFile);
const log = createLogger("responder");

export async function generateResponse(
  review: PendingReview,
  prDiff: string,
  issueBody: string,
): Promise<string> {
  const prompt = `You are responding to a code review comment on a pull request you submitted for a GitHub bounty.

## Original Issue
${issueBody}

## PR Diff (abbreviated)
${prDiff.slice(0, 8000)}

## Review Comment (by @${review.author})
${review.commentBody}

## Instructions
- Be professional, concise, and helpful
- If they request changes, acknowledge and explain what you'll fix
- If they ask questions, answer clearly
- If they approve, thank them
- Do NOT be defensive about AI-generated code
- Keep your response under 300 words

Your response:`;

  return runClaude(prompt, { timeoutMs: 60_000 });
}

export async function postResponse(
  review: PendingReview,
  responseBody: string,
): Promise<void> {
  log.info(
    { prUrl: review.prUrl, commentId: review.commentId },
    "Posting review response",
  );

  await execFileAsync("gh", [
    "pr",
    "comment",
    String(review.prNumber),
    "--repo",
    `${review.repoOwner}/${review.repoName}`,
    "--body",
    responseBody,
  ]);

  // Record the response
  const db = getDb();
  db.update(schema.prReviews)
    .set({
      responseBody,
      respondedAt: new Date(),
    })
    .where(eq(schema.prReviews.commentId, String(review.commentId)))
    .run();

  log.info("Response posted");
}

export async function getPrDiff(
  owner: string,
  repo: string,
  prNumber: number,
): Promise<string> {
  const { stdout } = await execFileAsync("gh", [
    "pr",
    "diff",
    String(prNumber),
    "--repo",
    `${owner}/${repo}`,
  ]);
  return stdout;
}
