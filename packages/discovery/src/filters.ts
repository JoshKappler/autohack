import { getConfig, createLogger, type Bounty } from "@algora/core";

const log = createLogger("filters");

interface FilterableIssue {
  repoOwner: string;
  repoName: string;
  language?: string | null;
  rewardCents: number;
  createdAt?: string;
}

export function passesFilters(issue: FilterableIssue): boolean {
  const config = getConfig();

  // Minimum reward
  if (issue.rewardCents <= 0) {
    log.debug({ rewardCents: issue.rewardCents }, "Filtered: zero or negative reward");
    return false;
  }

  // Excluded orgs
  if (config.EXCLUDE_ORGS.includes(issue.repoOwner)) {
    log.debug({ org: issue.repoOwner }, "Filtered: excluded org");
    return false;
  }

  // Excluded repos
  const repoFull = `${issue.repoOwner}/${issue.repoName}`;
  if (config.EXCLUDE_REPOS.includes(repoFull)) {
    log.debug({ repo: repoFull }, "Filtered: excluded repo");
    return false;
  }

  // Language filter (empty = all)
  if (
    config.TARGET_LANGUAGES.length > 0 &&
    issue.language &&
    !config.TARGET_LANGUAGES.includes(issue.language)
  ) {
    log.debug({ language: issue.language }, "Filtered: language mismatch");
    return false;
  }

  return true;
}
