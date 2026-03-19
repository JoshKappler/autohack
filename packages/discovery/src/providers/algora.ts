import { getConfig, createLogger } from "@algora/core";
import { fetchAllBounties } from "../algora-client";
import type { BountyProvider, DiscoveredBounty } from "../provider";

const log = createLogger("provider:algora");

export class AlgoraProvider implements BountyProvider {
  readonly name = "algora" as const;
  readonly displayName = "Algora";

  isEnabled(): boolean {
    return getConfig().ALGORA_ENABLED;
  }

  async fetchBounties(): Promise<DiscoveredBounty[]> {
    const raw = await fetchAllBounties();
    const results: DiscoveredBounty[] = [];

    for (const b of raw) {
      if (!b.task?.repo_owner || !b.task?.repo_name || !b.task?.number || !b.task?.title) {
        log.debug({ id: b.id }, "Skipping bounty with incomplete task data");
        continue;
      }

      const rewardCents = b.reward.amount;
      if (rewardCents === 0) {
        log.debug({ id: b.id }, "Skipping: $0 reward");
        continue;
      }

      // Sanity-check: compare against formatted string
      if (b.reward_formatted) {
        const cleaned = b.reward_formatted.replace(/[^0-9.]/g, "");
        const formattedCents = Math.round(parseFloat(cleaned) * 100);
        if (formattedCents !== 0 && formattedCents !== rewardCents) {
          log.warn({
            id: b.id,
            rewardAmount: rewardCents,
            rewardFormatted: b.reward_formatted,
            parsedFromFormatted: formattedCents,
          }, "Reward amount/formatted mismatch — SDK amount may not be in cents");
        }
      }

      results.push({
        providerBountyId: b.id,
        provider: "algora",
        sourceUrl: `https://algora.io/bounties/${b.id}`,
        githubUrl: b.task.url || `https://github.com/${b.task.repo_owner}/${b.task.repo_name}/issues/${b.task.number}`,
        repoOwner: b.task.repo_owner,
        repoName: b.task.repo_name,
        issueNumber: b.task.number,
        title: b.task.title,
        body: b.task.body,
        rewardCents,
        currency: b.reward.currency,
        paymentGuaranteed: true,
      });
    }

    log.info({ count: results.length }, "Fetched bounties from Algora");
    return results;
  }
}
