import { eq, and, sql } from "drizzle-orm";
import {
  getDb,
  schema,
  createLogger,
  type NewBounty,
} from "@algora/core";
import { passesFilters } from "./filters";
import type { BountyProvider, DiscoveredBounty } from "./provider";
import { getEnabledProviders } from "./providers/index";

const log = createLogger("poller");

/**
 * Central polling function that handles filtering, dedup, and insertion
 * for any bounty provider.
 */
async function pollProvider(provider: BountyProvider): Promise<number> {
  if (!provider.isEnabled()) return 0;

  const providerLog = createLogger(`poller:${provider.name}`);
  providerLog.info(`Starting ${provider.displayName} poll`);
  const db = getDb();

  const bounties = await provider.fetchBounties();
  let newCount = 0;

  for (const b of bounties) {
    if (
      !passesFilters({
        repoOwner: b.repoOwner,
        repoName: b.repoName,
        rewardCents: b.rewardCents,
      })
    ) {
      continue;
    }

    // Generate stable ID: provider-owner-repo-issueNumber
    const id = `${b.provider}-${b.repoOwner}-${b.repoName}-${b.issueNumber}`;

    // 1. Check exact ID match
    const existing = db
      .select()
      .from(schema.bounties)
      .where(eq(schema.bounties.id, id))
      .get();

    if (existing) continue;

    // 2. Cross-provider dedup: same GitHub issue from any source
    const sameIssue = db
      .select()
      .from(schema.bounties)
      .where(
        and(
          eq(schema.bounties.repoOwner, b.repoOwner),
          eq(schema.bounties.repoName, b.repoName),
          eq(schema.bounties.issueNumber, b.issueNumber),
        ),
      )
      .get();

    if (sameIssue) {
      if (b.rewardCents > sameIssue.rewardCents) {
        const now = new Date();
        db.update(schema.bounties)
          .set({ rewardCents: b.rewardCents, sourceUrl: b.sourceUrl, updatedAt: now })
          .where(eq(schema.bounties.id, sameIssue.id))
          .run();
        providerLog.info(
          { existingId: sameIssue.id, oldReward: sameIssue.rewardCents, newReward: b.rewardCents },
          "Updated bounty to higher reward from different source",
        );
      } else {
        providerLog.debug({ id }, "Skipping: lower/equal reward for existing issue");
      }
      continue;
    }

    // 3. Title dedup within same org
    const sameTitle = db
      .select()
      .from(schema.bounties)
      .where(
        and(
          eq(schema.bounties.repoOwner, b.repoOwner),
          eq(schema.bounties.title, b.title),
        ),
      )
      .get();

    if (sameTitle) {
      if (b.rewardCents > sameTitle.rewardCents) {
        const now = new Date();
        db.update(schema.bounties)
          .set({ rewardCents: b.rewardCents, sourceUrl: b.sourceUrl, updatedAt: now })
          .where(eq(schema.bounties.id, sameTitle.id))
          .run();
        providerLog.info(
          { existingId: sameTitle.id, newId: id, title: b.title },
          "Updated duplicate title bounty to higher reward",
        );
      } else {
        providerLog.debug({ id, existingId: sameTitle.id }, "Skipping: duplicate title in same org");
      }
      continue;
    }

    // 4. Insert new bounty
    const now = new Date();
    const newBounty: NewBounty = {
      id,
      provider: b.provider,
      providerBountyId: b.providerBountyId,
      sourceUrl: b.sourceUrl,
      paymentGuaranteed: b.paymentGuaranteed,
      githubUrl: b.githubUrl,
      repoOwner: b.repoOwner,
      repoName: b.repoName,
      issueNumber: b.issueNumber,
      title: b.title,
      body: b.body,
      labels: b.labels ? JSON.stringify(b.labels) : undefined,
      rewardCents: b.rewardCents,
      currency: b.currency,
      status: "discovered",
      discoveredAt: now,
      updatedAt: now,
    };

    db.insert(schema.bounties).values(newBounty).run();
    newCount++;
    providerLog.info(
      { id, title: b.title, reward: `$${(b.rewardCents / 100).toFixed(2)}` },
      "Discovered new bounty",
    );
  }

  // Reconciliation: mark bounties no longer in the API as removed
  const apiIds = new Set(bounties.map(b => b.providerBountyId));
  const activeDbBounties = db
    .select({ id: schema.bounties.id, providerBountyId: schema.bounties.providerBountyId })
    .from(schema.bounties)
    .where(and(
      eq(schema.bounties.provider, provider.name),
      sql`${schema.bounties.status} NOT IN ('merged', 'rejected', 'failed', 'removed')`,
    ))
    .all();

  let removedCount = 0;
  const now = new Date();
  for (const dbBounty of activeDbBounties) {
    if (dbBounty.providerBountyId && !apiIds.has(dbBounty.providerBountyId)) {
      db.update(schema.bounties)
        .set({ status: "removed", updatedAt: now })
        .where(eq(schema.bounties.id, dbBounty.id))
        .run();
      removedCount++;
      providerLog.info({ id: dbBounty.id }, "Bounty no longer listed — marked as removed");
    }
  }

  providerLog.info({ newCount, removedCount }, `${provider.displayName} poll complete`);
  return newCount;
}

// ── Thin wrappers for backward compatibility ─────────────────────

import { AlgoraProvider } from "./providers/algora";
import { GitHubProvider } from "./providers/github";

const algoraProvider = new AlgoraProvider();
const githubProvider = new GitHubProvider();

export async function pollAlgora(): Promise<number> {
  return pollProvider(algoraProvider);
}

export async function pollGitHub(): Promise<number> {
  return pollProvider(githubProvider);
}

export async function pollAllProviders(): Promise<number> {
  const providers = getEnabledProviders();
  let total = 0;
  for (const p of providers) {
    try {
      total += await pollProvider(p);
    } catch (err) {
      log.error({ err, provider: p.name }, `${p.displayName} poll failed`);
    }
  }
  return total;
}
