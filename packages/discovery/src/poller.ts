import { eq, and } from "drizzle-orm";
import {
  getDb,
  schema,
  createLogger,
  type NewBounty,
} from "@algora/core";
import { fetchAllBounties } from "./algora-client";
import { searchBountyIssues } from "./github-client";
import { passesFilters } from "./filters";

const log = createLogger("poller");

function parseCentsFromFormatted(formatted: string): number {
  // "$50.00" -> 5000, "$1,000" -> 100000
  const cleaned = formatted.replace(/[^0-9.]/g, "");
  return Math.round(parseFloat(cleaned) * 100);
}

export async function pollAlgora(): Promise<number> {
  log.info("Starting Algora SDK poll");
  const db = getDb();

  try {
    const bounties = await fetchAllBounties();
    let newCount = 0;

    for (const b of bounties) {
      // Skip bounties with incomplete task data
      if (!b.task?.repo_owner || !b.task?.repo_name || !b.task?.number || !b.task?.title) {
        log.debug({ id: b.id }, "Skipping bounty with incomplete task data");
        continue;
      }

      // reward.amount from the SDK is already in cents
      const rewardCents = b.reward.amount;

      // Sanity-check: compare against formatted string if available
      if (b.reward_formatted) {
        const formattedCents = parseCentsFromFormatted(b.reward_formatted);
        if (formattedCents !== 0 && formattedCents !== rewardCents) {
          log.warn({
            id: b.id,
            rewardAmount: rewardCents,
            rewardFormatted: b.reward_formatted,
            parsedFromFormatted: formattedCents,
          }, "Reward amount/formatted mismatch — SDK amount may not be in cents");
        }
      }

      if (rewardCents === 0) {
        log.debug({ id: b.id }, "Skipping: $0 reward");
        continue;
      }

      if (
        !passesFilters({
          repoOwner: b.task.repo_owner,
          repoName: b.task.repo_name,
          rewardCents,
        })
      ) {
        continue;
      }

      // Check if already exists
      const existing = db
        .select()
        .from(schema.bounties)
        .where(eq(schema.bounties.id, b.id))
        .get();

      if (existing) continue;

      // Deduplicate by GitHub issue — keep only the highest reward tier
      const sameIssue = db
        .select()
        .from(schema.bounties)
        .where(
          and(
            eq(schema.bounties.repoOwner, b.task.repo_owner),
            eq(schema.bounties.repoName, b.task.repo_name),
            eq(schema.bounties.issueNumber, b.task.number),
          ),
        )
        .get();

      if (sameIssue) {
        if (rewardCents > sameIssue.rewardCents) {
          const now = new Date();
          db.update(schema.bounties)
            .set({ rewardCents, algoraUrl: `https://algora.io/bounties/${b.id}`, updatedAt: now })
            .where(eq(schema.bounties.id, sameIssue.id))
            .run();
          log.info(
            { existingId: sameIssue.id, oldReward: sameIssue.rewardCents, newReward: rewardCents },
            "Updated bounty to higher reward tier",
          );
        } else {
          log.debug({ id: b.id }, "Skipping: lower/equal reward tier for existing issue");
        }
        continue;
      }

      const now = new Date();
      const newBounty: NewBounty = {
        id: b.id,
        algoraUrl: `https://algora.io/bounties/${b.id}`,
        githubUrl: b.task.url || `https://github.com/${b.task.repo_owner}/${b.task.repo_name}/issues/${b.task.number}`,
        repoOwner: b.task.repo_owner,
        repoName: b.task.repo_name,
        issueNumber: b.task.number,
        title: b.task.title,
        body: b.task.body,
        rewardCents,
        currency: b.reward.currency,
        status: "discovered",
        discoveredAt: now,
        updatedAt: now,
      };

      db.insert(schema.bounties).values(newBounty).run();
      newCount++;
      log.info(
        {
          id: b.id,
          title: b.task.title,
          reward: b.reward_formatted,
        },
        "Discovered new bounty",
      );
    }

    log.info({ newCount }, "Algora poll complete");
    return newCount;
  } catch (err) {
    log.error({ err }, "Algora poll failed");
    return 0;
  }
}

export async function pollGitHub(): Promise<number> {
  log.info("Starting GitHub deep poll");
  const db = getDb();

  try {
    const issues = await searchBountyIssues();
    let newCount = 0;

    for (const issue of issues) {
      // Generate a stable ID from repo + issue number
      const id = `gh-${issue.owner}-${issue.repo}-${issue.number}`;

      const existing = db
        .select()
        .from(schema.bounties)
        .where(eq(schema.bounties.id, id))
        .get();

      if (existing) continue;

      // Deduplicate by GitHub issue — skip if already discovered via Algora
      const sameIssue = db
        .select()
        .from(schema.bounties)
        .where(
          and(
            eq(schema.bounties.repoOwner, issue.owner),
            eq(schema.bounties.repoName, issue.repo),
            eq(schema.bounties.issueNumber, issue.number),
          ),
        )
        .get();

      if (sameIssue) {
        log.debug({ id, existingId: sameIssue.id }, "Skipping: issue already tracked via another source");
        continue;
      }

      // Try to extract bounty amount from labels
      let rewardCents = 0;
      for (const label of issue.labels) {
        const match = label.match(/\$(\d[\d,]*(?:\.\d{2})?)/);
        if (match) {
          rewardCents = parseCentsFromFormatted(match[0]);
          break;
        }
      }

      // Skip if we can't determine reward or it doesn't pass filters
      if (rewardCents === 0) {
        log.debug(
          { issue: `${issue.owner}/${issue.repo}#${issue.number}` },
          "Skipping: could not determine reward",
        );
        continue;
      }

      if (
        !passesFilters({
          repoOwner: issue.owner,
          repoName: issue.repo,
          rewardCents,
        })
      ) {
        continue;
      }

      const now = new Date();
      const newBounty: NewBounty = {
        id,
        githubUrl: issue.htmlUrl,
        repoOwner: issue.owner,
        repoName: issue.repo,
        issueNumber: issue.number,
        title: issue.title,
        body: issue.body,
        labels: JSON.stringify(issue.labels),
        rewardCents,
        status: "discovered",
        discoveredAt: now,
        updatedAt: now,
      };

      db.insert(schema.bounties).values(newBounty).run();
      newCount++;
      log.info(
        {
          id,
          title: issue.title,
          reward: `$${(rewardCents / 100).toFixed(2)}`,
        },
        "Discovered new bounty (GitHub)",
      );
    }

    log.info({ newCount }, "GitHub poll complete");
    return newCount;
  } catch (err) {
    log.error({ err }, "GitHub poll failed");
    return 0;
  }
}
