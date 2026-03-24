import { getConfig, createLogger } from "@bounty/core";

const log = createLogger("huntr-client");

/**
 * Huntr program — each represents a bounty-eligible open source project.
 * Huntr focuses on AI/ML open source projects on GitHub.
 */
export interface HuntrProgram {
  id: string;
  handle: string;
  name: string;
  url: string;
  repoUrl: string;
  rewardMaxCents: number | null;
  rewardMinCents: number | null;
}

/**
 * Fetch Huntr bounty programs.
 *
 * Huntr has no public API or structured data feed. We scrape the bounties page
 * HTML to extract GitHub repo URLs. Falls back to an empty list on failure
 * (Huntr's page is JS-heavy and may not render server-side).
 *
 * For a more reliable source, Huntr programs can also be manually seeded
 * by looking at https://huntr.com/bounties and adding repos to the DB.
 */
export async function fetchHuntrPrograms(): Promise<HuntrProgram[]> {
  const programs: HuntrProgram[] = [];

  try {
    const response = await fetch("https://huntr.com/bounties", {
      headers: {
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
        "Accept": "text/html,application/xhtml+xml",
      },
    });
    if (!response.ok) {
      log.warn({ status: response.status }, "Huntr page fetch failed");
      return [];
    }

    const html = await response.text();

    // Try __NEXT_DATA__ for structured data
    const nextDataMatch = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
    if (nextDataMatch) {
      try {
        const nextData = JSON.parse(nextDataMatch[1]);
        // Navigate through possible Next.js page props structures
        const props = nextData?.props?.pageProps;
        const bountyItems = props?.bounties ?? props?.programs ?? props?.repos ?? [];
        for (const item of bountyItems) {
          const prog = parseHuntrItem(item);
          if (prog) programs.push(prog);
        }
      } catch (err) {
        log.debug({ err }, "Failed to parse __NEXT_DATA__ from Huntr");
      }
    }

    // Fallback: extract GitHub repo links from HTML
    if (programs.length === 0) {
      // Huntr lists repos like "owner/repo" linking to GitHub
      const repoPattern = /https:\/\/github\.com\/([\w.-]+\/[\w.-]+)/g;
      const seen = new Set<string>();
      let match;
      while ((match = repoPattern.exec(html)) !== null) {
        const repoFullName = match[1].replace(/\/+$/, "");
        // Skip common non-project repos (huntr's own, github meta pages)
        if (repoFullName.includes("huntr") || repoFullName.split("/").length !== 2) continue;
        if (seen.has(repoFullName)) continue;
        seen.add(repoFullName);

        const handle = repoFullName.replace("/", "-").toLowerCase();
        programs.push({
          id: `huntr-${handle}`,
          handle,
          name: repoFullName,
          url: "https://huntr.com/bounties",
          repoUrl: `https://github.com/${repoFullName}`,
          rewardMaxCents: 300000, // Huntr standard: up to $3,000
          rewardMinCents: null,
        });
      }
    }
  } catch (err) {
    log.error({ err }, "Huntr fetch failed entirely");
  }

  log.info({ count: programs.length }, "Huntr fetch complete");
  return programs;
}

function parseHuntrItem(item: any): HuntrProgram | null {
  if (!item) return null;
  const name = item.name ?? item.repo ?? item.title ?? "";
  if (!name) return null;

  const repoUrl = item.repo_url ?? item.repoUrl ?? item.url ?? "";
  const handle = name.toLowerCase().replace(/[^a-z0-9-]/g, "-");

  let maxCents: number | null = null;
  if (item.max_bounty != null) maxCents = Math.round(Number(item.max_bounty) * 100);
  else if (item.maxBounty != null) maxCents = Math.round(Number(item.maxBounty) * 100);
  else maxCents = 300000; // Default Huntr max

  return {
    id: item.id ?? `huntr-${handle}`,
    handle,
    name,
    url: item.url ?? "https://huntr.com/bounties",
    repoUrl: typeof repoUrl === "string" && repoUrl.includes("github.com") ? repoUrl : "",
    rewardMaxCents: maxCents,
    rewardMinCents: null,
  };
}
