import {
  getConfig,
  createLogger,
  extractJsonWithKey,
  runClaude,
  runClaudeStructured,
  type SecurityProgram,
  type SecurityFinding,
} from "@bounty/core";

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

export interface ProgramAssessmentRubric {
  sourceCodeQuality: number; // 0-3: 0=none, 1=limited/unfamiliar-lang, 2=some repos in known langs, 3=extensive repos in JS/TS/Python/Go/Ruby
  webApiSurface: number; // 0-3: 0=none, 1=few restricted, 2=moderate with wildcards, 3=broad web+API
  techStackMatch: number; // 0-3: 0=unknown/untestable, 1=partial, 2=good, 3=perfect (JS/TS/Python)
  scopeBreadth: number; // 0-3: 0=single narrow, 1=few targets, 2=moderate, 3=wide with many assets
  rewardEfficiency: number; // 0-3: 0=no reward/low efficiency, 1=low, 2=decent, 3=high reward+efficiency
}

export interface ProgramAssessmentResult {
  opportunityScore: number; // 0-1, computed from rubric (sum / 15)
  rubric: ProgramAssessmentRubric;
  targetCount: number; // number of promising targets in scope
  topTargets: Array<{ asset: string; type: string; reasoning: string; strategy?: string }>;
  techStack: string[];
  attackSurface: string; // brief description
  hasSourceCode: boolean; // deterministically computed from scopes, not LLM
  recommendedApproach: "code_review" | "web_testing" | "api_testing" | "mixed";
}

/** Check if a scope entry represents source code. */
function isScopeSourceCode(s: { assetIdentifier: string; assetType: string }): boolean {
  return (
    s.assetType === "SOURCE_CODE" ||
    s.assetIdentifier?.includes("github.com") ||
    s.assetIdentifier?.includes("gitlab.com")
  );
}

/** Clamp a rubric score to 0-3 integer. */
function clampRubric(val: unknown): number {
  const n = Number(val);
  if (isNaN(n)) return 0;
  return Math.max(0, Math.min(3, Math.round(n)));
}

/** Compute opportunityScore from rubric sub-scores (0-1 scale). */
function computeOpportunityScore(rubric: ProgramAssessmentRubric): number {
  const sum =
    rubric.sourceCodeQuality +
    rubric.webApiSurface +
    rubric.techStackMatch +
    rubric.scopeBreadth +
    rubric.rewardEfficiency;
  return Math.round((sum / 15) * 100) / 100;
}

/**
 * Assess a security program's scope to determine opportunity for finding vulnerabilities.
 * Uses rubric-based scoring to avoid LLM score clustering.
 */
export async function assessProgram(
  program: SecurityProgram,
): Promise<ProgramAssessmentResult> {
  const config = getConfig();

  let scopes: Array<{ assetIdentifier: string; assetType: string; instruction?: string }> = [];
  let policyText = "";
  let weaknessNames: string[] = [];
  try {
    const parsed = JSON.parse(program.scopeSummary || "[]");
    scopes = parsed.scopes ?? (Array.isArray(parsed) ? parsed : []);
    if (parsed.policy) {
      policyText = `\nProgram Policy (excerpt):\n${String(parsed.policy).slice(0, 1500)}\n`;
    }
    if (parsed.weaknesses && Array.isArray(parsed.weaknesses)) {
      weaknessNames = parsed.weaknesses;
    }
  } catch {}

  // Deterministically detect source code availability from ALL scopes (not truncated)
  const sourceCodeScopes = scopes.filter(isScopeSourceCode);
  const hasSourceCode = sourceCodeScopes.length > 0;

  // Reorder scopes: source code first so they appear in the prompt even with truncation
  const orderedScopes = [
    ...sourceCodeScopes,
    ...scopes.filter((s) => !sourceCodeScopes.includes(s)),
  ];

  const sourceCodeNote = hasSourceCode
    ? `\n**NOTE: This program has ${sourceCodeScopes.length} source code repositor${sourceCodeScopes.length === 1 ? "y" : "ies"} in scope. sourceCodeQuality should be at least 1.**\n`
    : "";

  const rewardRange = program.rewardMinCents && program.rewardMaxCents
    ? `$${(program.rewardMinCents / 100).toFixed(0)} - $${(program.rewardMaxCents / 100).toFixed(0)}`
    : program.rewardMaxCents
      ? `up to $${(program.rewardMaxCents / 100).toFixed(0)}`
      : "unknown";

  const prompt = `You are a security researcher evaluating a bug bounty program for AI-powered automated vulnerability discovery. The AI agent can: clone and review source code, make HTTP requests with curl, analyze DNS records, read documentation, run semgrep for static analysis, port scan with nmap, run nuclei vulnerability templates, discover directories with ffuf, and run nikto web scans. It CANNOT: render JavaScript (no browser/SPA interaction), create accounts on target services, or use Burp Suite/Metasploit.

Program: ${program.name}
Platform: ${program.provider}
Reward Range: ${rewardRange}
Response Efficiency: ${program.responseEfficiency != null ? `${(program.responseEfficiency * 100).toFixed(0)}%` : "unknown"}
Status: ${program.status}
Source Code in Scope: ${hasSourceCode ? `YES (${sourceCodeScopes.length} repos)` : "NO"}
${weaknessNames.length > 0 ? `Accepted Weakness Types: ${weaknessNames.slice(0, 20).join(", ")}${weaknessNames.length > 20 ? ` (and ${weaknessNames.length - 20} more)` : ""}\n` : ""}${policyText}${sourceCodeNote}

In-Scope Assets (${scopes.length} total):
${orderedScopes.slice(0, 40).map((s, i) => `${i + 1}. [${s.assetType}] ${s.assetIdentifier}${s.instruction ? ` — ${s.instruction}` : ""}`).join("\n")}
${scopes.length > 40 ? `... and ${scopes.length - 40} more` : ""}

Evaluate this program using the rubric below. Score each dimension 0-3 independently.

RUBRIC:
1. **sourceCodeQuality** (0-3): How valuable is the source code for our AI agent?
   - 0: No source code in scope
   - 1: Source code exists but in unfamiliar languages (C, Rust, Java) or very limited repos
   - 2: Some repos in languages we're good at (JS/TS, Python, Go, Ruby, PHP)
   - 3: Extensive repos in our strongest languages with complex business logic

2. **webApiSurface** (0-3): How much web/API attack surface is testable?
   - 0: No web or API targets (mobile/hardware only)
   - 1: Few restricted endpoints, no wildcards
   - 2: Moderate web surface with some wildcards or documented APIs
   - 3: Broad web+API surface with wildcards, many endpoints, clear documentation

3. **techStackMatch** (0-3): How well does the tech stack match our capabilities?
   - 0: Unknown or untestable (embedded, firmware, mobile-only)
   - 1: Partial match — some testable components mixed with untestable ones
   - 2: Good match — primarily web technologies we can analyze
   - 3: Perfect match — JS/TS, Python, or Go stack with standard web frameworks

4. **scopeBreadth** (0-3): How broad is the attack surface?
   - 0: Single narrow target or heavily restricted scope
   - 1: A few targets with moderate restrictions
   - 2: Moderate scope with 5-20 diverse assets
   - 3: Wide scope with many assets, wildcards, and few restrictions

5. **rewardEfficiency** (0-3): Is the reward worth the effort and is payout likely?
   - 0: No reward, extremely low reward, or very low response efficiency (<30%)
   - 1: Low reward (<$500 max) OR unknown response efficiency
   - 2: Decent reward ($500-$5000 max) AND decent efficiency (50-70%)
   - 3: High reward (>$5000 max) AND high efficiency (>70%)

Respond with ONLY valid JSON, no markdown fences:
{"rubric": {"sourceCodeQuality": 0-3, "webApiSurface": 0-3, "techStackMatch": 0-3, "scopeBreadth": 0-3, "rewardEfficiency": 0-3}, "targetCount": number, "topTargets": [{"asset": string, "type": string, "reasoning": string, "strategy": "code_review"|"web_testing"|"api_testing"|"domain_recon"}], "techStack": string[], "attackSurface": string, "recommendedApproach": "code_review"|"web_testing"|"api_testing"|"mixed"}`;

  log.debug({ name: program.name, hasSourceCode }, "Assessing program opportunity");

  try {
    const parsed = await runClaudeStructured<any>(prompt, {
      model: config.ANALYSIS_MODEL,
      maxTokens: 1024,
      temperature: 0,
      timeoutMs: 180_000,
      disableTools: true,
      toolName: "assess_program",
      fallbackKey: "rubric",
      inputSchema: {
        type: "object",
        properties: {
          rubric: {
            type: "object",
            properties: {
              sourceCodeQuality: { type: "integer", minimum: 0, maximum: 3 },
              webApiSurface: { type: "integer", minimum: 0, maximum: 3 },
              techStackMatch: { type: "integer", minimum: 0, maximum: 3 },
              scopeBreadth: { type: "integer", minimum: 0, maximum: 3 },
              rewardEfficiency: { type: "integer", minimum: 0, maximum: 3 },
            },
            required: ["sourceCodeQuality", "webApiSurface", "techStackMatch", "scopeBreadth", "rewardEfficiency"],
          },
          targetCount: { type: "integer" },
          topTargets: {
            type: "array",
            items: {
              type: "object",
              properties: {
                asset: { type: "string" },
                type: { type: "string" },
                reasoning: { type: "string" },
                strategy: { type: "string", enum: ["code_review", "web_testing", "api_testing", "domain_recon"] },
              },
              required: ["asset", "type", "reasoning"],
            },
          },
          techStack: { type: "array", items: { type: "string" } },
          attackSurface: { type: "string" },
          recommendedApproach: { type: "string", enum: ["code_review", "web_testing", "api_testing", "mixed"] },
        },
        required: ["rubric", "targetCount", "topTargets", "techStack", "attackSurface", "recommendedApproach"],
      },
    });
    if (!parsed) {
      throw new Error("Could not parse program assessment — no valid JSON returned");
    }

    // Normalize rubric scores to 0-3 integers
    const rubric: ProgramAssessmentRubric = {
      sourceCodeQuality: clampRubric(parsed.rubric?.sourceCodeQuality),
      webApiSurface: clampRubric(parsed.rubric?.webApiSurface),
      techStackMatch: clampRubric(parsed.rubric?.techStackMatch),
      scopeBreadth: clampRubric(parsed.rubric?.scopeBreadth),
      rewardEfficiency: clampRubric(parsed.rubric?.rewardEfficiency),
    };

    // Override: if we deterministically know source code exists but LLM scored 0, bump to 1
    if (hasSourceCode && rubric.sourceCodeQuality === 0) {
      rubric.sourceCodeQuality = 1;
    }

    const opportunityScore = computeOpportunityScore(rubric);

    const result: ProgramAssessmentResult = {
      opportunityScore,
      rubric,
      targetCount: parsed.targetCount ?? 0,
      topTargets: (parsed.topTargets ?? []).slice(0, 5),
      techStack: parsed.techStack ?? [],
      attackSurface: parsed.attackSurface ?? "",
      hasSourceCode,
      recommendedApproach: parsed.recommendedApproach ?? "mixed",
    };

    log.info(
      {
        name: program.name,
        opportunityScore: result.opportunityScore,
        rubric,
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
    const result = await runClaudeStructured<SecurityAssessmentResult>(prompt, {
      model: config.ANALYSIS_MODEL,
      maxTokens: 1024,
      temperature: 0,
      timeoutMs: 180_000,
      disableTools: true,
      toolName: "assess_finding",
      fallbackKey: "difficulty",
      inputSchema: {
        type: "object",
        properties: {
          difficulty: { type: "number", minimum: 0, maximum: 1 },
          confidence: { type: "number", minimum: 0, maximum: 1 },
          severity: { type: "string", enum: ["critical", "high", "medium", "low", "informational"] },
          vulnerabilityType: { type: "string" },
          approach: { type: "string" },
          riskFactors: { type: "array", items: { type: "string" } },
          estimatedRewardCents: { type: "integer" },
        },
        required: ["difficulty", "confidence", "severity", "vulnerabilityType", "approach", "riskFactors", "estimatedRewardCents"],
      },
    });
    if (!result) {
      throw new Error("Could not parse finding assessment — no valid JSON returned");
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
