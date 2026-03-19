import {
  getConfig,
  createLogger,
  extractJsonWithKey,
  runClaude,
  type FeasibilityResult,
  type RepoInfo,
} from "@algora/core";

const log = createLogger("feasibility");

export async function assessFeasibility(
  issueTitle: string,
  issueBody: string | null,
  labels: string[],
  repoInfo: RepoInfo,
  competitorCount: number,
  rewardCents: number,
  issueComments: string,
): Promise<FeasibilityResult> {
  const config = getConfig();
  const rewardDollars = (rewardCents / 100).toFixed(0);

  const prompt = `You are evaluating a GitHub issue for automated resolution by Claude Code (Claude Opus 4.6 with extended thinking).
The solver works autonomously: it can read code, edit files, run tests, and create a PR — but it CANNOT access external services, APIs, databases, or hardware. It works entirely within the git repo. It has a high turn limit and can work through complex problems methodically.

Repository: ${repoInfo.owner}/${repoInfo.name} (${repoInfo.language ?? "unknown"}, ${repoInfo.stars} stars, ${repoInfo.sizeKb}KB)
Has CI: ${repoInfo.hasCI}
Test framework: ${repoInfo.testFramework ?? "unknown"}
Open issues: ${repoInfo.openIssues}

Issue: ${issueTitle}
Labels: ${labels.join(", ")}
Bounty reward: $${rewardDollars}
Body:
${(issueBody ?? "(no body)").slice(0, 4000)}

${issueComments ? `Key discussion (from issue comments):\n${issueComments}\n` : ""}Competitors: ${competitorCount} other solver(s) have posted /attempt

IMPORTANT — Be brutally honest about feasibility. Your score directly determines whether we spend compute attempting this bounty. An overestimate wastes resources; an underestimate just means we skip it.

Reward strongly correlates with complexity:
- $50-$200 bounties: Often straightforward bug fixes or small features. These can genuinely be high feasibility.
- $500-$1,000 bounties: Moderate complexity. Usually involve understanding multiple files, edge cases, or non-trivial logic.
- $1,000-$5,000 bounties: Significant work. Multi-file changes, architectural understanding required, often underspecified.
- $5,000+ bounties: Major initiatives. Deep architectural work, cross-cutting concerns, or problems that have stumped human developers. An autonomous AI solving these is rare.
- $10,000+ bounties: Almost certainly beyond autonomous AI capability. These are posted because they're genuinely hard problems.

Rate feasibility (0-1): How likely can Claude Opus 4.6 with extended thinking solve this FULLY and AUTONOMOUSLY?

Score LOW (< 0.3) for:
- High-reward bounties (>$1,000) unless the scope is surprisingly narrow and crystal clear
- Issues requiring external service access, API keys, or credentials
- Issues needing multi-service coordination or infrastructure changes
- Vague, unclear, or incomplete requirements
- Issues with no body text — a missing description almost always means unclear requirements
- Large refactors touching many files across the codebase
- Issues requiring deep domain expertise (cryptography, ML models, etc.)
- Issues that need human judgment calls on design/UX

Score MODERATE (0.3-0.6) for:
- Well-defined tasks that still require significant codebase understanding
- Issues with clear requirements but non-trivial implementation
- Bug fixes that need investigation to find root cause

Score HIGH (> 0.7) ONLY for:
- Clear bug reports with reproduction steps AND low reward (<$500)
- Small, focused changes (1-5 files) with specific requirements
- Issues where the fix is almost obvious from the description
- Repos with a known test framework make verification easier — the solver can run tests to confirm its fix

Set requiresPlanComment to true when:
- Bounty reward is >$500 (higher-stakes work benefits from maintainer alignment)
- The approach involves changes to more than 5 files
- The issue has ambiguous or underspecified requirements
- Multiple valid approaches exist and maintainer preference matters
Set it to false for clear, small, low-reward fixes where the right approach is obvious.

Respond with ONLY valid JSON, no markdown fences:
{"feasibility": number, "riskFactors": string[], "approach": string, "requiresPlanComment": boolean}`;

  log.debug({ title: issueTitle }, "Assessing feasibility");

  try {
    const text = await runClaude(prompt, {
      model: config.ANALYSIS_MODEL,
      maxTokens: 1024,
    });

    const result = extractJsonWithKey<FeasibilityResult>(text, "feasibility");
    if (!result) {
      throw new Error(`Could not parse feasibility JSON from response: ${text.slice(0, 200)}`);
    }

    // Sanity-check the values
    result.feasibility = Math.max(0, Math.min(1, result.feasibility ?? 0.5));
    result.riskFactors = result.riskFactors ?? [];
    result.approach = result.approach ?? "";
    result.requiresPlanComment = result.requiresPlanComment ?? false;

    log.info(
      {
        title: issueTitle,
        feasibility: result.feasibility,
        reward: `$${rewardDollars}`,
      },
      "Feasibility assessed",
    );

    return result;
  } catch (err: any) {
    log.error({ err, title: issueTitle }, "Feasibility assessment failed");
    throw err;
  }
}
