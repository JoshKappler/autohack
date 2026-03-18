import { getConfig, getDb, schema, createLogger } from "@algora/core";
import { eq } from "drizzle-orm";
import { checkForReviews } from "./review-watcher";
import {
  generateResponse,
  postResponse,
  getPrDiff,
} from "./responder";
import { fixReviewFeedback } from "./review-fixer";

const log = createLogger("monitor");

/**
 * Classify whether a review comment is requesting code changes (vs. a question,
 * approval, or general discussion).
 */
function looksLikeChangeRequest(body: string): boolean {
  const lower = body.toLowerCase();
  const patterns = [
    "please change", "please fix", "please update", "please remove",
    "should be", "needs to be", "must be", "instead of",
    "can you", "could you", "would you",
    "this breaks", "this doesn't", "this won't", "this isn't",
    "wrong", "incorrect", "bug", "error", "issue",
    "nit:", "suggestion:", "requested changes",
  ];
  return patterns.some((p) => lower.includes(p));
}

export async function monitorReviews(): Promise<void> {
  const config = getConfig();
  const db = getDb();

  const pendingReviews = await checkForReviews();

  if (pendingReviews.length === 0) return;

  // Group reviews by bounty for batch processing
  const byBounty = new Map<string, typeof pendingReviews>();
  for (const review of pendingReviews) {
    const existing = byBounty.get(review.bountyId) ?? [];
    existing.push(review);
    byBounty.set(review.bountyId, existing);
  }

  for (const review of pendingReviews) {
    try {
      // Get PR diff for context
      const diff = await getPrDiff(
        review.repoOwner,
        review.repoName,
        review.prNumber,
      );

      // Get original issue body
      const bounty = db
        .select()
        .from(schema.bounties)
        .where(eq(schema.bounties.id, review.bountyId))
        .get();

      const issueBody = bounty?.body ?? "";

      // Generate response
      const response = await generateResponse(review, diff, issueBody);

      if (config.AUTO_RESPOND_REVIEWS) {
        await postResponse(review, response);
      } else {
        log.info(
          {
            bountyId: review.bountyId,
            comment: review.commentBody.slice(0, 100),
            suggestedResponse: response.slice(0, 200),
          },
          "Review response ready (awaiting manual approval)",
        );
      }

      // If auto-fix is enabled and the comment looks like a change request,
      // attempt to fix the code and push
      if (config.AUTO_FIX_REVIEWS && looksLikeChangeRequest(review.commentBody)) {
        log.info(
          { bountyId: review.bountyId, reviewer: review.author },
          "Review looks like a change request — attempting auto-fix",
        );

        const allBountyReviews = byBounty.get(review.bountyId) ?? [review];
        const fixed = await fixReviewFeedback(review, allBountyReviews);

        if (fixed) {
          // Post a follow-up comment letting the reviewer know
          const followUp = `I've pushed a fix addressing your feedback. Please take another look when you get a chance.`;
          await postResponse(
            { ...review, commentId: Date.now() }, // use unique ID for the follow-up
            followUp,
          );
        }
      }
    } catch (err) {
      log.error({ err, review }, "Failed to handle review");
    }
  }
}

export { checkForReviews } from "./review-watcher";
export { generateResponse, postResponse, getPrDiff } from "./responder";
export { fixReviewFeedback } from "./review-fixer";
