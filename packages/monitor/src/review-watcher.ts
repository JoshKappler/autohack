import { Octokit } from "@octokit/rest";
import { eq } from "drizzle-orm";
import { getConfig, getDb, schema, createLogger } from "@algora/core";

const log = createLogger("review-watcher");

export interface PendingReview {
  bountyId: string;
  prUrl: string;
  prNumber: number;
  repoOwner: string;
  repoName: string;
  commentId: number;
  commentBody: string;
  author: string;
}

export async function checkForReviews(): Promise<PendingReview[]> {
  const db = getDb();
  const config = getConfig();
  const octokit = new Octokit({ auth: config.GITHUB_TOKEN });

  // Get all bounties with open PRs
  const activePRs = db
    .select()
    .from(schema.bounties)
    .where(eq(schema.bounties.status, "pr_created"))
    .all()
    .concat(
      db
        .select()
        .from(schema.bounties)
        .where(eq(schema.bounties.status, "in_review"))
        .all(),
    );

  if (activePRs.length === 0) {
    log.debug("No active PRs to monitor");
    return [];
  }

  const pending: PendingReview[] = [];

  for (const bounty of activePRs) {
    if (!bounty.prNumber) continue;

    try {
      // Fetch PR reviews
      const { data: reviews } = await octokit.pulls.listReviews({
        owner: bounty.repoOwner,
        repo: bounty.repoName,
        pull_number: bounty.prNumber,
      });

      // Fetch PR comments
      const { data: comments } = await octokit.pulls.listReviewComments({
        owner: bounty.repoOwner,
        repo: bounty.repoName,
        pull_number: bounty.prNumber,
      });

      // Also check issue-style comments on the PR
      const { data: issueComments } = await octokit.issues.listComments({
        owner: bounty.repoOwner,
        repo: bounty.repoName,
        issue_number: bounty.prNumber,
      });

      // Check for new comments we haven't responded to
      const allComments = [
        ...reviews
          .filter((r) => r.body && r.state !== "APPROVED")
          .map((r) => ({
            id: r.id,
            body: r.body ?? "",
            author: r.user?.login ?? "",
          })),
        ...comments.map((c) => ({
          id: c.id,
          body: c.body,
          author: c.user?.login ?? "",
        })),
        ...issueComments
          .filter((c) => !c.body?.includes("Automated solution"))
          .map((c) => ({
            id: c.id,
            body: c.body ?? "",
            author: c.user?.login ?? "",
          })),
      ];

      for (const comment of allComments) {
        // Skip our own comments and bot comments
        if (comment.author === "" || comment.body.includes("/claim")) continue;

        // Check if we already have this comment tracked
        const existing = db
          .select()
          .from(schema.prReviews)
          .where(eq(schema.prReviews.commentId, String(comment.id)))
          .get();

        if (existing) continue;

        // Insert and add to pending
        db.insert(schema.prReviews)
          .values({
            bountyId: bounty.id,
            prUrl: bounty.prUrl!,
            commentId: String(comment.id),
            commentBody: comment.body,
          })
          .run();

        pending.push({
          bountyId: bounty.id,
          prUrl: bounty.prUrl!,
          prNumber: bounty.prNumber,
          repoOwner: bounty.repoOwner,
          repoName: bounty.repoName,
          commentId: comment.id,
          commentBody: comment.body,
          author: comment.author,
        });
      }

      // Update status if we found reviews
      if (pending.length > 0 && bounty.status === "pr_created") {
        db.update(schema.bounties)
          .set({ status: "in_review", updatedAt: new Date() })
          .where(eq(schema.bounties.id, bounty.id))
          .run();
      }

      // Check if PR was merged
      const { data: pr } = await octokit.pulls.get({
        owner: bounty.repoOwner,
        repo: bounty.repoName,
        pull_number: bounty.prNumber,
      });

      if (pr.merged) {
        db.update(schema.bounties)
          .set({
            status: "merged",
            earnedCents: bounty.rewardCents,
            updatedAt: new Date(),
          })
          .where(eq(schema.bounties.id, bounty.id))
          .run();
        log.info({ bountyId: bounty.id, prUrl: bounty.prUrl }, "PR merged!");
      } else if (pr.state === "closed") {
        db.update(schema.bounties)
          .set({ status: "rejected", updatedAt: new Date() })
          .where(eq(schema.bounties.id, bounty.id))
          .run();
        log.info({ bountyId: bounty.id }, "PR was closed without merge");
      }
    } catch (err) {
      log.error(
        { err, bountyId: bounty.id },
        "Failed to check PR reviews",
      );
    }
  }

  if (pending.length > 0) {
    log.info({ count: pending.length }, "Found new review comments");
  }

  return pending;
}
