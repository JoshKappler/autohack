import { Octokit } from "@octokit/rest";
import { getConfig, createLogger, type RepoInfo } from "@algora/core";

const log = createLogger("codebase-scout");

export async function scoutRepo(
  owner: string,
  name: string,
): Promise<RepoInfo> {
  const octokit = new Octokit({ auth: getConfig().GITHUB_TOKEN });

  const { data: repo } = await octokit.repos.get({ owner, repo: name });

  // Check for CI
  let hasCI = false;
  try {
    await octokit.repos.getContent({
      owner,
      repo: name,
      path: ".github/workflows",
    });
    hasCI = true;
  } catch {
    // No workflows directory
  }

  log.info(
    {
      repo: `${owner}/${name}`,
      language: repo.language,
      sizeKb: repo.size,
      stars: repo.stargazers_count,
      hasCI,
    },
    "Scouted repo",
  );

  return {
    owner,
    name,
    language: repo.language,
    sizeKb: repo.size,
    stars: repo.stargazers_count,
    hasCI,
    openIssues: repo.open_issues_count,
  };
}

export async function countCompetition(
  owner: string,
  repo: string,
  issueNumber: number,
): Promise<{ attempts: number; existingPRs: number }> {
  const octokit = new Octokit({ auth: getConfig().GITHUB_TOKEN });

  let attempts = 0;
  let existingPRs = 0;

  try {
    const { data: comments } = await octokit.issues.listComments({
      owner,
      repo,
      issue_number: issueNumber,
      per_page: 100,
    });

    // Deduplicate /attempt comments by user
    const attemptUsers = new Set<string>();
    for (const c of comments) {
      if (c.body?.toLowerCase().includes("/attempt") && c.user?.login) {
        attemptUsers.add(c.user.login);
      }
    }
    attempts = attemptUsers.size;
  } catch (err: any) {
    if (err.status === 404) {
      log.warn({ owner, repo, issueNumber }, "Issue not found when counting competitors, assuming 0");
    } else {
      throw err;
    }
  }

  try {
    const { data: prs } = await octokit.pulls.list({
      owner,
      repo,
      state: "open",
      per_page: 100,
    });

    const issueRef = `#${issueNumber}`;
    const urlRef = `/${owner}/${repo}/issues/${issueNumber}`;
    existingPRs = prs.filter((pr) => {
      const body = (pr.body ?? "").toLowerCase();
      const title = pr.title.toLowerCase();
      return body.includes(issueRef) || body.includes(urlRef) || title.includes(issueRef);
    }).length;
  } catch (err: any) {
    log.warn({ err, owner, repo, issueNumber }, "Failed to count existing PRs, assuming 0");
  }

  return { attempts, existingPRs };
}
