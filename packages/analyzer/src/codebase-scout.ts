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

  // Detect test framework
  let testFramework: string | null = null;
  const testConfigs = [
    { path: "jest.config.js", name: "jest" },
    { path: "jest.config.ts", name: "jest" },
    { path: "vitest.config.ts", name: "vitest" },
    { path: "vitest.config.js", name: "vitest" },
    { path: "pytest.ini", name: "pytest" },
    { path: "setup.cfg", name: "pytest" },
    { path: ".mocharc.yml", name: "mocha" },
    { path: ".mocharc.json", name: "mocha" },
    { path: "karma.conf.js", name: "karma" },
  ];
  for (const { path, name: framework } of testConfigs) {
    try {
      await octokit.repos.getContent({ owner, repo: name, path });
      testFramework = framework;
      break;
    } catch {
      // Not found, try next
    }
  }

  log.info(
    {
      repo: `${owner}/${name}`,
      language: repo.language,
      sizeKb: repo.size,
      stars: repo.stargazers_count,
      hasCI,
      testFramework,
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
    testFramework,
  };
}

/** Fetch non-bot issue comments, concatenated and truncated for use in feasibility assessment. */
export async function fetchIssueComments(
  owner: string,
  repo: string,
  issueNumber: number,
): Promise<{ commentText: string; comments: Array<{ body: string; login: string }> }> {
  const octokit = new Octokit({ auth: getConfig().GITHUB_TOKEN });

  try {
    const { data: comments } = await octokit.issues.listComments({
      owner,
      repo,
      issue_number: issueNumber,
      per_page: 100,
    });

    const nonBotComments = comments.filter(
      (c) => c.user && !c.user.login.endsWith("[bot]") && c.user.type !== "Bot",
    );

    const parsed = nonBotComments
      .filter((c) => c.body && c.user?.login)
      .map((c) => ({ body: c.body!, login: c.user!.login }));

    // Build truncated comment text for the feasibility prompt
    let text = "";
    for (const c of parsed) {
      const entry = `@${c.login}: ${c.body}\n\n`;
      if (text.length + entry.length > 2000) break;
      text += entry;
    }

    return { commentText: text.trim(), comments: parsed };
  } catch (err: any) {
    if (err.status === 404) {
      log.warn({ owner, repo, issueNumber }, "Issue not found when fetching comments");
    } else {
      throw err;
    }
    return { commentText: "", comments: [] };
  }
}

export async function countCompetition(
  owner: string,
  repo: string,
  issueNumber: number,
  comments: Array<{ body: string; login: string }>,
): Promise<{ attempts: number; existingPRs: number }> {
  const octokit = new Octokit({ auth: getConfig().GITHUB_TOKEN });

  // Count unique /attempt commands — match as standalone command, not substring
  const attemptRegex = /(?:^|\s)\/attempt(?:\s|$)/im;
  const attemptUsers = new Set<string>();
  for (const c of comments) {
    if (attemptRegex.test(c.body)) {
      attemptUsers.add(c.login);
    }
  }

  let existingPRs = 0;
  const prAuthors = new Set<string>();

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
      const matches = body.includes(issueRef) || body.includes(urlRef) || title.includes(issueRef);
      if (matches && pr.user?.login) prAuthors.add(pr.user.login);
      return matches;
    }).length;
  } catch (err: any) {
    log.warn({ err, owner, repo, issueNumber }, "Failed to count existing PRs, assuming 0");
  }

  // Deduplicate: if someone has both /attempt and an open PR, only count the PR
  const uniqueAttempts = [...attemptUsers].filter((u) => !prAuthors.has(u)).length;

  return { attempts: uniqueAttempts, existingPRs };
}
