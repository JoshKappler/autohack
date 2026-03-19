import {
  getConfig,
  createLogger,
  extractJsonWithKey,
  runClaude,
  type SecurityProgram,
  type SecurityFinding,
} from "@algora/core";

const log = createLogger("security-assessor");

export interface SecurityAssessmentResult {
  difficulty: number; // 0-1, how hard is this to exploit/validate
  confidence: number; // 0-1, how confident are we this is a real vuln
  severity: "critical" | "high" | "medium" | "low" | "informational";
  vulnerabilityType: string; // CWE or category
  approach: string; // brief plan for validation/exploitation
  riskFactors: string[];
  estimatedRewardCents: number;
}

export interface ProgramAssessmentResult {
  opportunityScore: number; // 0-1, how likely to find vulns
  targetCount: number; // number of promising targets in scope
  topTargets: Array<{ asset: string; type: string; reasoning: string; strategy?: string }>;
  techStack: string[];
  attackSurface: string; // brief description
  hasSourceCode?: boolean; // whether source code repos are in scope
  recommendedApproach?: "code_review" | "web_testing" | "api_testing" | "mixed";
}

/**
 * Assess a security program's scope to determine opportunity for finding vulnerabilities.
 * Uses Haiku for fast, cheap assessment.
 */
export async function assessProgram(
  program: SecurityProgram,
): Promise<ProgramAssessmentResult> {
  const config = getConfig();

  let scopes: Array<{ assetIdentifier: string; assetType: string; instruction?: string }> = [];
  let policyText = "";
  try {
    const parsed = JSON.parse(program.scopeSummary || "[]");
    scopes = parsed.scopes ?? (Array.isArray(parsed) ? parsed : []);
    if (parsed.policy) {
      policyText = `\nProgram Policy (excerpt):\n${String(parsed.policy).slice(0, 1500)}\n`;
    }
  } catch {}

  const rewardRange = program.rewardMinCents && program.rewardMaxCents
    ? `$${(program.rewardMinCents / 100).toFixed(0)} - $${(program.rewardMaxCents / 100).toFixed(0)}`
    : program.rewardMaxCents
      ? `up to $${(program.rewardMaxCents / 100).toFixed(0)}`
      : "unknown";

  const prompt = `You are a security researcher evaluating a bug bounty program for AI-powered automated vulnerability discovery. The AI agent can: clone and review source code, make HTTP requests with curl, analyze DNS records, read documentation, and run semgrep for static analysis. It CANNOT: render JavaScript, use a browser, create accounts, run nmap/sqlmap.

Program: ${program.name}
Platform: ${program.provider}
Reward Range: ${rewardRange}
Response Efficiency: ${program.responseEfficiency != null ? `${(program.responseEfficiency * 100).toFixed(0)}%` : "unknown"}
Status: ${program.status}
${policyText}

In-Scope Assets (${scopes.length} total):
${scopes.slice(0, 30).map((s, i) => `${i + 1}. [${s.assetType}] ${s.assetIdentifier}${s.instruction ? ` — ${s.instruction}` : ""}`).join("\n")}
${scopes.length > 30 ? `... and ${scopes.length - 30} more` : ""}

Evaluate this program for automated AI security testing potential.

KEY FACTORS (in priority order):
1. **Source code availability** — Programs with SOURCE_CODE assets (GitHub/GitLab repos) are HIGHEST priority. AI code review is our strongest capability — it finds logic bugs, injection flaws, and auth bypasses that surface scanning misses. If ANY source code repo is in scope, score at least 0.5.
2. **Technology match** — We are best at reviewing JavaScript/TypeScript, Python, Go, Ruby, and PHP code. Score higher for these.
3. **Web application targets** — Testable via curl for XSS, SQLI, IDOR, auth bypass, etc.
4. **API endpoints** — Good targets for authorization testing, input validation, business logic flaws.
5. **Wildcard scope** — Programs with wildcard domains (*.example.com) have larger attack surfaces.
6. **Response efficiency** — Programs with > 70% response efficiency are more likely to actually pay out.
7. **Mobile/hardware/IoT** — We CANNOT test these effectively. Score low for mobile-only programs.

Rate opportunity (0-1): How likely is our AI agent to find valid, accepted vulnerabilities?

Score LOW (< 0.3) for:
- Programs with only mobile/hardware/IoT scope
- Programs with very restrictive rules or narrow scope
- Programs that are extremely mature with minimal web surface

Score MODERATE (0.3-0.6) for:
- Programs with web targets but competitive/well-tested
- Programs with APIs that could be tested for auth/authz issues
- Mixed scope with some testable targets

Score HIGH (> 0.7) for:
- Programs with source code repositories in scope (especially JS/TS, Python, Go, Ruby)
- Programs with many web application targets and broad scope
- Programs with clear API documentation
- Programs with good response efficiency and fair reward ranges

For topTargets, ALWAYS prioritize: source code repos first, then APIs with documentation, then web applications. Include a "strategy" field for each target.

Respond with ONLY valid JSON, no markdown fences:
{"opportunityScore": number, "targetCount": number, "topTargets": [{"asset": string, "type": string, "reasoning": string, "strategy": "code_review"|"web_testing"|"api_testing"|"domain_recon"}], "techStack": string[], "attackSurface": string, "hasSourceCode": boolean, "recommendedApproach": "code_review"|"web_testing"|"api_testing"|"mixed"}`;

  log.debug({ name: program.name }, "Assessing program opportunity");

  try {
    const text = await runClaude(prompt, {
      model: config.ANALYSIS_MODEL,
      maxTokens: 1024,
      temperature: 0,
      timeoutMs: 180_000, // 3 min — Sonnet via CLI needs time for startup + reasoning
    });

    const result = extractJsonWithKey<ProgramAssessmentResult>(text, "opportunityScore");
    if (!result) {
      throw new Error(`Could not parse program assessment JSON: ${text.slice(0, 200)}`);
    }

    result.opportunityScore = Math.max(0, Math.min(1, result.opportunityScore ?? 0.5));
    result.targetCount = result.targetCount ?? 0;
    result.topTargets = (result.topTargets ?? []).slice(0, 5);
    result.techStack = result.techStack ?? [];
    result.attackSurface = result.attackSurface ?? "";
    result.hasSourceCode = result.hasSourceCode ?? false;
    result.recommendedApproach = result.recommendedApproach ?? "mixed";

    log.info(
      {
        name: program.name,
        opportunityScore: result.opportunityScore,
        targets: result.targetCount,
        hasSourceCode: result.hasSourceCode,
        approach: result.recommendedApproach,
      },
      "Program assessed",
    );

    return result;
  } catch (err: any) {
    log.error({ err, name: program.name }, "Program assessment failed");
    throw err;
  }
}

/**
 * Assess a security finding's validity and difficulty.
 * Uses Haiku for fast triage.
 */
export async function assessFinding(
  finding: SecurityFinding,
  program: SecurityProgram,
): Promise<SecurityAssessmentResult> {
  const config = getConfig();

  const rewardRange = program.rewardMinCents && program.rewardMaxCents
    ? `$${(program.rewardMinCents / 100).toFixed(0)} - $${(program.rewardMaxCents / 100).toFixed(0)}`
    : "unknown";

  const prompt = `You are a security researcher triaging a potential vulnerability finding for a bug bounty program.

Program: ${program.name} (${program.provider})
Reward Range: ${rewardRange}
Target Asset: ${finding.targetAsset ?? "unknown"}

Finding Title: ${finding.title}
Description:
${(finding.description ?? "(no description)").slice(0, 4000)}

Current Severity: ${finding.severity ?? "unrated"}
Current Vuln Type: ${finding.vulnerabilityType ?? "unknown"}

Assess this finding's validity, severity, and difficulty of exploitation. Be brutally honest.

Score difficulty (0-1) — how hard to reproduce and validate:
- LOW difficulty (< 0.3): Easy to reproduce, clear steps, obvious impact
- MODERATE (0.3-0.6): Requires some setup or chaining
- HIGH (> 0.7): Complex exploitation, multiple prerequisites, or uncertain impact

Score confidence (0-1) — how likely this is a real, valid vulnerability:
- LOW (< 0.3): Likely false positive, informational only, or already known
- MODERATE (0.3-0.6): Plausible but needs validation
- HIGH (> 0.7): Strong evidence, clear exploitation path

Respond with ONLY valid JSON, no markdown fences:
{"difficulty": number, "confidence": number, "severity": "critical"|"high"|"medium"|"low"|"informational", "vulnerabilityType": string, "approach": string, "riskFactors": string[], "estimatedRewardCents": number}`;

  log.debug({ title: finding.title }, "Assessing finding");

  try {
    const text = await runClaude(prompt, {
      model: config.ANALYSIS_MODEL,
      maxTokens: 1024,
      temperature: 0,
      timeoutMs: 180_000, // 3 min — Sonnet via CLI needs time for startup + reasoning
    });

    const result = extractJsonWithKey<SecurityAssessmentResult>(text, "difficulty");
    if (!result) {
      throw new Error(`Could not parse finding assessment JSON: ${text.slice(0, 200)}`);
    }

    result.difficulty = Math.max(0, Math.min(1, result.difficulty ?? 0.5));
    result.confidence = Math.max(0, Math.min(1, result.confidence ?? 0.5));
    result.riskFactors = result.riskFactors ?? [];
    result.approach = result.approach ?? "";
    result.estimatedRewardCents = result.estimatedRewardCents ?? 0;

    log.info(
      { title: finding.title, confidence: result.confidence, severity: result.severity },
      "Finding assessed",
    );

    return result;
  } catch (err: any) {
    log.error({ err, title: finding.title }, "Finding assessment failed");
    throw err;
  }
}
