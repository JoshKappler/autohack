import {
  getConfig,
  createLogger,
  runClaude,
  type FeasibilityResult,
  type RepoInfo,
} from "@algora/core";

const log = createLogger("feasibility");

const DEFAULT_RESULT: FeasibilityResult = {
  feasibility: 0.5,
  estimatedHours: 4,
  riskFactors: ["analysis could not be completed — using default score"],
  approach: "Needs manual review.",
  requiresPlanComment: false,
};

export async function assessFeasibility(
  issueTitle: string,
  issueBody: string | null,
  labels: string[],
  repoInfo: RepoInfo,
  competitorCount: number,
): Promise<FeasibilityResult> {
  const config = getConfig();

  const prompt = `You are evaluating a GitHub issue for automated resolution by an AI coding assistant (Claude Code).
The AI assistant works autonomously: it can read code, edit files, run tests, and create a PR — but it CANNOT access external services, APIs, databases, or hardware. It works entirely within the git repo.

Repository: ${repoInfo.owner}/${repoInfo.name} (${repoInfo.language ?? "unknown"}, ${repoInfo.stars} stars, ${repoInfo.sizeKb}KB)
Has CI: ${repoInfo.hasCI}
Open issues: ${repoInfo.openIssues}

Issue: ${issueTitle}
Labels: ${labels.join(", ")}
Body:
${(issueBody ?? "(no body)").slice(0, 4000)}

Competitors: ${competitorCount} other solver(s) have posted /attempt

Rate this bounty honestly based on the issue clarity and scope:

1. feasibility (0-1): How likely can an AI solve this AUTONOMOUSLY? Score LOW (< 0.3) for:
   - Issues requiring external service access, API keys, or credentials
   - Issues needing multi-service coordination or infrastructure changes
   - Issues with vague, unclear, or incomplete requirements
   - Large refactors touching many files across the codebase
   - Issues requiring deep domain expertise (cryptography, ML models, etc.)
   - Issues that need human judgment calls on design/UX
   Score HIGH (> 0.7) for:
   - Clear bug reports with reproduction steps
   - Well-defined feature requests with specific requirements
   - Issues in languages Claude excels at (TypeScript, Python, Rust, Go)
   - Small, focused changes (1-5 files)

2. estimated_hours (0.5-40): Realistic estimate including codebase exploration, implementation, and testing. Be generous — most estimates are too optimistic.

3. risk_factors: List specific risks.

4. approach: Brief 2-3 sentence solution strategy.

5. requires_plan_comment (true/false): Does the issue explicitly ask solvers to share/post an implementation plan in the comments before starting work? Only true if the issue body clearly states this requirement.

Respond with ONLY valid JSON, no markdown fences:
{"feasibility": number, "estimatedHours": number, "riskFactors": string[], "approach": string, "requiresPlanComment": boolean}`;

  log.debug({ title: issueTitle }, "Assessing feasibility");

  try {
    const text = await runClaude(prompt, {
      model: config.ANALYSIS_MODEL,
      maxTokens: 1024,
    });

    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      log.warn({ response: text }, "Could not parse feasibility JSON, using defaults");
      return DEFAULT_RESULT;
    }

    const result = JSON.parse(jsonMatch[0]) as FeasibilityResult;

    // Sanity-check the values
    result.feasibility = Math.max(0, Math.min(1, result.feasibility ?? 0.5));
    result.estimatedHours = Math.max(0.5, result.estimatedHours ?? 4);
    result.riskFactors = result.riskFactors ?? [];
    result.approach = result.approach ?? "";
    result.requiresPlanComment = result.requiresPlanComment ?? false;

    log.info(
      {
        title: issueTitle,
        feasibility: result.feasibility,
        hours: result.estimatedHours,
      },
      "Feasibility assessed",
    );

    return result;
  } catch (err: any) {
    log.warn({ err, title: issueTitle }, "Feasibility assessment failed, using defaults");
    return DEFAULT_RESULT;
  }
}
