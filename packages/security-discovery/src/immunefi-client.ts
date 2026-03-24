import { getConfig, createLogger } from "@bounty/core";

const log = createLogger("immunefi-client");

/**
 * Immunefi program data parsed from the snapshot repo.
 * All Immunefi programs have smart contract source code in scope.
 */
export interface ImmunefiProgram {
  id: string;
  handle: string;
  name: string;
  url: string;
  rewardMaxCents: number | null;
  rewardMinCents: number | null;
  launchedAt: string | null;
  assets: Array<{
    assetType: string;
    assetIdentifier: string;
    description: string;
    eligibleForBounty: boolean;
  }>;
}

// The snapshot repo (pratraut/Immunefi-Bug-Bounty-Programs-Snapshots) stores:
// - projects.json: index with id, project name, maximum_reward, launchDate
// - projects/{id}.json: full detail under pageProps.bounty.assets[]
const SNAPSHOT_INDEX = "https://raw.githubusercontent.com/pratraut/Immunefi-Bug-Bounty-Programs-Snapshots/main/projects.json";
const SNAPSHOT_PROJECT = (id: string) =>
  `https://raw.githubusercontent.com/pratraut/Immunefi-Bug-Bounty-Programs-Snapshots/main/projects/${id}.json`;

/**
 * Fetch all active Immunefi bounty programs from the snapshot repo.
 * First fetches the index, then fetches individual project files for asset details.
 * Rate-limited to avoid GitHub raw CDN throttling.
 */
export async function fetchImmunefiPrograms(): Promise<ImmunefiProgram[]> {
  // Step 1: Fetch the index
  const indexResp = await fetch(SNAPSHOT_INDEX);
  if (!indexResp.ok) {
    throw new Error(`Immunefi index fetch failed: ${indexResp.status}`);
  }
  const index: any[] = await indexResp.json();
  log.info({ count: index.length }, "Fetched Immunefi program index");

  const programs: ImmunefiProgram[] = [];

  // Step 2: Fetch each project's detail for assets
  // Rate limit: 200ms between requests to avoid GitHub throttling
  let fetched = 0;
  let errors = 0;
  for (const entry of index) {
    const id = entry.id;
    if (!id) continue;

    try {
      const detailResp = await fetch(SNAPSHOT_PROJECT(id));
      if (!detailResp.ok) {
        errors++;
        if (errors > 20) {
          log.warn("Too many Immunefi detail fetch errors, stopping early");
          break;
        }
        continue;
      }

      const detail = await detailResp.json();
      const bounty = detail?.pageProps?.bounty;
      const rawAssets: any[] = bounty?.assets ?? [];

      const assets: ImmunefiProgram["assets"] = rawAssets.map((a: any) => ({
        assetType: a.type === "smart_contract" ? "SOURCE_CODE" : (a.type ?? "OTHER"),
        assetIdentifier: a.url ?? "",
        description: a.description ?? "",
        eligibleForBounty: true,
      }));

      const maxReward = entry.maximum_reward;

      programs.push({
        id,
        handle: id,
        name: entry.project ?? id,
        url: `https://immunefi.com/bug-bounty/${id}/`,
        rewardMaxCents: maxReward != null ? Math.round(Number(maxReward) * 100) : null,
        rewardMinCents: null,
        launchedAt: entry.launchDate ?? entry.date ?? null,
        assets,
      });

      fetched++;
    } catch (err) {
      errors++;
      log.debug({ err, id }, "Failed to fetch Immunefi project detail");
      if (errors > 20) {
        log.warn("Too many Immunefi detail fetch errors, stopping early");
        break;
      }
    }

    // Rate limit
    await new Promise(r => setTimeout(r, 200));
  }

  log.info({ total: programs.length, fetched, errors }, "Immunefi fetch complete");
  return programs;
}
