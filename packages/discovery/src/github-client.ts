import { Octokit } from "@octokit/rest";
import { getConfig, createLogger } from "@algora/core";

const log = createLogger("github-client");
let _octokit: Octokit | null = null;

function getOctokit(): Octokit {
  if (_octokit) return _octokit;
  _octokit = new Octokit({ auth: getConfig().GITHUB_TOKEN });
  return _octokit;
}

export interface GitHubBountyIssue {
  owner: string;
  repo: string;
  number: number;
  title: string;
  body: string | null;
  labels: string[];
  htmlUrl: string;
  createdAt: string;
}

export async function searchBountyIssues(): Promise<GitHubBountyIssue[]> {
  const octokit = getOctokit();
  const config = getConfig();

  const cutoffDate = new Date();
  cutoffDate.setDate(cutoffDate.getDate() - config.MAX_ISSUE_AGE_DAYS);
  const dateStr = cutoffDate.toISOString().split("T")[0];

  // Search for open issues with bounty label created after cutoff
  const q = `label:"💎 Bounty" state:open created:>${dateStr}`;
  log.debug({ query: q }, "Searching GitHub for bounty issues");

  const results: GitHubBountyIssue[] = [];
  let page = 1;

  while (true) {
    const { data } = await octokit.search.issuesAndPullRequests({
      q,
      sort: "created",
      order: "desc",
      per_page: 100,
      page,
    });

    for (const item of data.items) {
      if (item.pull_request) continue; // skip PRs

      const [owner, repo] = (item.repository_url ?? "")
        .replace("https://api.github.com/repos/", "")
        .split("/");

      if (!owner || !repo) continue;

      results.push({
        owner,
        repo,
        number: item.number,
        title: item.title,
        body: item.body,
        labels: item.labels.map((l) =>
          typeof l === "string" ? l : l.name ?? "",
        ),
        htmlUrl: item.html_url,
        createdAt: item.created_at,
      });
    }

    if (data.items.length < 100) break;
    page++;
  }

  log.info({ count: results.length }, "Found bounty issues on GitHub");
  return results;
}

export async function getRepoInfo(owner: string, name: string) {
  const octokit = getOctokit();
  const { data } = await octokit.repos.get({ owner, repo: name });

  return {
    owner,
    name,
    language: data.language,
    sizeKb: data.size,
    stars: data.stargazers_count,
    openIssues: data.open_issues_count,
    hasCI: false, // checked separately
  };
}

export async function getIssueDetails(
  owner: string,
  repo: string,
  issueNumber: number,
) {
  const octokit = getOctokit();
  const { data } = await octokit.issues.get({
    owner,
    repo,
    issue_number: issueNumber,
  });
  return data;
}

export async function getIssueComments(
  owner: string,
  repo: string,
  issueNumber: number,
) {
  const octokit = getOctokit();
  const { data } = await octokit.issues.listComments({
    owner,
    repo,
    issue_number: issueNumber,
    per_page: 100,
  });
  return data;
}
