import { createLogger } from "@bounty/core";

const log = createLogger("aggregator-client");

/**
 * Program data from the bounty-targets-data aggregator.
 * Provides hourly-updated scope dumps from Bugcrowd, Intigriti, YesWeHack, and Federacy.
 * We filter to programs with source code in scope.
 */
export interface AggregatorProgram {
  provider: string;
  handle: string;
  name: string;
  url: string;
  scopes: Array<{
    assetType: string;
    assetIdentifier: string;
    eligibleForBounty: boolean;
    instruction?: string;
  }>;
  hasSourceCode: boolean;
  rewardMaxCents: number | null;
}

const BASE_URL = "https://raw.githubusercontent.com/arkadiyt/bounty-targets-data/main/data";

// Platform-specific JSON files. HackerOne skipped — we have our own integration.
const PLATFORM_FILES: Record<string, string> = {
  bugcrowd: `${BASE_URL}/bugcrowd_data.json`,
  intigriti: `${BASE_URL}/intigriti_data.json`,
  yeswehack: `${BASE_URL}/yeswehack_data.json`,
  federacy: `${BASE_URL}/federacy_data.json`,
};

/**
 * Fetch programs from the bounty-targets-data aggregator.
 * Only returns programs with source code in scope (GitHub/GitLab repos).
 */
export async function fetchAggregatorPrograms(opts?: { sourceCodeOnly?: boolean }): Promise<AggregatorProgram[]> {
  const sourceCodeOnly = opts?.sourceCodeOnly ?? true;
  const allPrograms: AggregatorProgram[] = [];

  for (const [platform, fileUrl] of Object.entries(PLATFORM_FILES)) {
    try {
      const programs = await fetchPlatformData(platform, fileUrl);
      const filtered = sourceCodeOnly ? programs.filter(p => p.hasSourceCode) : programs;
      allPrograms.push(...filtered);
      log.info({ platform, total: programs.length, withSourceCode: filtered.length }, "Fetched aggregator data");
    } catch (err) {
      log.warn({ err, platform }, "Failed to fetch aggregator data for platform");
    }
  }

  log.info({ total: allPrograms.length, sourceCodeOnly }, "Aggregator fetch complete");
  return allPrograms;
}

async function fetchPlatformData(platform: string, fileUrl: string): Promise<AggregatorProgram[]> {
  const response = await fetch(fileUrl);
  if (!response.ok) {
    throw new Error(`Aggregator fetch ${platform} ${response.status}`);
  }

  const data = await response.json();
  if (!Array.isArray(data)) return [];

  const programs: AggregatorProgram[] = [];
  for (const item of data) {
    const program = parsePlatformItem(platform, item);
    if (program) programs.push(program);
  }
  return programs;
}

/**
 * Parse a program from aggregator JSON.
 *
 * Data formats per platform (from bounty-targets-data):
 *
 * Bugcrowd:  { name, url, max_payout, targets: { in_scope: [{ target, uri, type, name }] } }
 * Intigriti: { name, handle, url, max_bounty, min_bounty, targets: { in_scope: [{ endpoint, type, description }] } }
 * YesWeHack: { name, url, targets: { in_scope: [{ target, type }] } }
 * Federacy:  { name, url, targets: { in_scope: [{ target, type }] } }
 */
function parsePlatformItem(platform: string, item: any): AggregatorProgram | null {
  if (!item) return null;

  const name = item.name ?? "";
  if (!name) return null;

  const handle = (item.handle ?? item.company_handle ?? name)
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-+/g, "-");

  const url = item.url ?? "";

  // Parse in-scope targets — field names differ per platform
  const scopes: AggregatorProgram["scopes"] = [];
  const inScope = item.targets?.in_scope ?? [];

  for (const t of inScope) {
    if (!t) continue;

    // Each platform uses different field names for the target URL:
    // Bugcrowd: uri or target, Intigriti: endpoint, YesWeHack/Federacy: target
    const identifier = t.uri ?? t.endpoint ?? t.target ?? "";
    if (!identifier) continue;

    const assetType = normalizeAssetType(t.type ?? inferAssetType(identifier));

    scopes.push({
      assetType,
      assetIdentifier: identifier,
      eligibleForBounty: true,
      instruction: t.description ?? t.name ?? undefined,
    });
  }

  const hasSourceCode = scopes.some(s =>
    s.assetType === "SOURCE_CODE" ||
    /github\.com|gitlab\.com|bitbucket\.org/.test(s.assetIdentifier),
  );

  // Parse rewards
  let rewardMaxCents: number | null = null;
  if (item.max_payout != null) {
    // Bugcrowd: max_payout is a number in dollars
    rewardMaxCents = Math.round(Number(item.max_payout) * 100);
  } else if (item.max_bounty != null) {
    // Intigriti: max_bounty in euros/dollars (treat as dollars)
    rewardMaxCents = Math.round(Number(item.max_bounty) * 100);
  }

  return { provider: platform, handle, name, url, scopes, hasSourceCode, rewardMaxCents };
}

function inferAssetType(target: string): string {
  if (/github\.com|gitlab\.com|bitbucket\.org/.test(target)) return "SOURCE_CODE";
  if (/^\*\./.test(target)) return "WILDCARD";
  if (/^https?:\/\//.test(target)) return "URL";
  if (/^[\w.-]+\.\w{2,}$/.test(target)) return "DOMAIN";
  return "OTHER";
}

function normalizeAssetType(type: string): string {
  const lower = (type ?? "").toLowerCase();
  if (lower.includes("source") || lower.includes("code") || lower.includes("github")) return "SOURCE_CODE";
  if (lower === "url" || lower.includes("web") || lower.includes("application")) return "URL";
  if (lower.includes("api")) return "URL";
  if (lower.includes("domain") || lower.includes("wildcard")) return "DOMAIN";
  if (lower.includes("android") || lower.includes("ios") || lower.includes("mobile")) return "MOBILE";
  return type.toUpperCase();
}
