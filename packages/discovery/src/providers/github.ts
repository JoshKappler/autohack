import { getConfig, createLogger } from "@algora/core";
import { searchBountyIssues } from "../github-client";
import type { BountyProvider, DiscoveredBounty } from "../provider";

const log = createLogger("provider:github");

function parseCentsFromFormatted(formatted: string): number {
  const cleaned = formatted.replace(/[^0-9.]/g, "");
  return Math.round(parseFloat(cleaned) * 100);
}

export class GitHubProvider implements BountyProvider {
  readonly name = "github" as const;
  readonly displayName = "GitHub";

  isEnabled(): boolean {
    return getConfig().GITHUB_SEARCH_ENABLED;
  }

  async fetchBounties(): Promise<DiscoveredBounty[]> {
    const issues = await searchBountyIssues();
    const results: DiscoveredBounty[] = [];

    for (const issue of issues) {
      let rewardCents = 0;
      for (const label of issue.labels) {
        const match = label.match(/\$(\d[\d,]*(?:\.\d{2})?)/);
        if (match) {
          rewardCents = parseCentsFromFormatted(match[0]);
          break;
        }
      }

      if (rewardCents === 0) {
        log.debug(
          { issue: `${issue.owner}/${issue.repo}#${issue.number}` },
          "Skipping: could not determine reward",
        );
        continue;
      }

      results.push({
        providerBountyId: `gh-${issue.owner}-${issue.repo}-${issue.number}`,
        provider: "github",
        sourceUrl: issue.htmlUrl,
        githubUrl: issue.htmlUrl,
        repoOwner: issue.owner,
        repoName: issue.repo,
        issueNumber: issue.number,
        title: issue.title,
        body: issue.body,
        labels: issue.labels,
        rewardCents,
        currency: "USD",
        paymentGuaranteed: false,
      });
    }

    log.info({ count: results.length }, "Fetched bounty issues from GitHub");
    return results;
  }
}
