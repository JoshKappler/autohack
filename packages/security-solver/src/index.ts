import { randomBytes } from "node:crypto";
import { eq, desc, and, or, isNull, lt } from "drizzle-orm";
import { getDb, schema, getConfig, createLogger, generateTraceId, classifyError, extractJsonWithKey, recordSecurityHuntOutcome, recordNearMiss, updateProgramNotes, runClaude, type SecurityFinding, type SecurityProgram } from "@algora/core";
import { runProgramHunt, runFindingSolver, killActiveSecurityProcess, detectHuntStrategy, buildAdversarialReviewPrompt, spawnAdversarialVerification } from "./claude-runner";
import { clearSecuritySolverStatus, writeAdversarialReviewStatus, clearAdversarialReviewStatus, readAdversarialReviewStatus, cancelAdversarialReview } from "./status";

const log = createLogger("security-solver");

let solving = false;

export function isSecuritySolving(): boolean { return solving; }

export { killActiveSecurityProcess } from "./claude-runner";
export { readSecuritySolverStatus, clearSecuritySolverStatus, readAdversarialReviewStatus, clearAdversarialReviewStatus, cancelAdversarialReview } from "./status";
export type { SecuritySolverStatus, AdversarialReviewStatus } from "./status";

/**
 * Hunt a program — spawns Claude Opus to investigate the program's scope,
 * find vulnerabilities, and create findings with reports.
 * This is the main "launch" action from the programs table.
 */
export async function huntProgram(
  program: SecurityProgram,
  trigger?: "auto" | "manual",
): Promise<{ findingsCreated: number }> {
  const db = getDb();

  if (solving) {
    throw new Error("Security solver is already busy");
  }

  solving = true;
  let findingsCreated = 0;
  let huntSucceeded = false;

  try {
    log.info({ programId: program.id, name: program.name }, "Starting program hunt");

    const result = await runProgramHunt(program, trigger);

    if (!result.success) {
      log.error({ programId: program.id, error: result.error }, "Program hunt failed");
      await recordSecurityHuntOutcome({
        programId: program.id,
        programName: program.name,
        findingsReported: 0,
        findingsAccepted: 0,
        findingsDuplicate: 0,
        findingsRejected: 0,
        strategyUsed: "failed" as any,
        timestamp: new Date().toISOString(),
      }).catch(() => {});
      return { findingsCreated: 0 };
    }

    huntSucceeded = true;

    // Quality gate: filter out low-value findings before DB insertion
    const config = getConfig();
    const minConfidence = config.SECURITY_MIN_CONFIDENCE;
    const ACCEPTED_SEVERITIES = new Set(["critical", "high", "medium"]);
    const EXCLUDED_TYPES = ["information disclosure", "missing security header", "csp",
      "technology fingerprinting", "version disclosure", "server header", "protection mechanism failure",
      "rate limiting", "open redirect", "clickjacking", "cookie"];

    // Create findings from the parsed results, recording near-misses for filtered ones
    const acceptedVulnTypes: string[] = [];
    let filtered = 0;
    for (const f of result.findings) {
      if (!ACCEPTED_SEVERITIES.has(f.severity)) {
        log.info({ title: f.title, severity: f.severity }, "Finding filtered: below minimum severity");
        filtered++;
        recordNearMiss({ programId: program.id, title: f.title, vulnType: f.vulnerabilityType ?? "unknown", reason: "low_severity", timestamp: new Date().toISOString() }).catch(() => {});
        continue;
      }
      if (f.confidence < minConfidence) {
        log.info({ title: f.title, confidence: f.confidence, threshold: minConfidence }, "Finding filtered: below confidence threshold");
        filtered++;
        recordNearMiss({ programId: program.id, title: f.title, vulnType: f.vulnerabilityType ?? "unknown", reason: "low_confidence", timestamp: new Date().toISOString() }).catch(() => {});
        continue;
      }
      const typeKey = (f.vulnerabilityType ?? "").toLowerCase();
      if (EXCLUDED_TYPES.some(ex => typeKey.includes(ex))) {
        log.info({ title: f.title, type: f.vulnerabilityType }, "Finding filtered: excluded vulnerability type");
        filtered++;
        recordNearMiss({ programId: program.id, title: f.title, vulnType: f.vulnerabilityType ?? "unknown", reason: "excluded_type", timestamp: new Date().toISOString() }).catch(() => {});
        continue;
      }

      const findingId = `sf-${randomBytes(8).toString("hex")}`;
      const traceId = generateTraceId();

      try {
        db.insert(schema.securityFindings)
          .values({
            id: findingId,
            programId: program.id,
            title: f.title,
            description: f.reportBody,
            severity: f.severity as any,
            vulnerabilityType: f.vulnerabilityType,
            targetAsset: f.targetAsset,
            status: "report_ready",
            confidenceScore: f.confidence,
            reportBody: f.reportBody,
            traceId,
            discoveredAt: new Date(),
            updatedAt: new Date(),
          })
          .run();

        findingsCreated++;
        if (f.vulnerabilityType) acceptedVulnTypes.push(f.vulnerabilityType);
        log.info(
          { findingId, title: f.title, severity: f.severity, confidence: f.confidence },
          "Finding created from hunt",
        );
      } catch (insertErr: any) {
        log.error(
          { err: insertErr, findingId, title: f.title },
          "Failed to insert finding into database",
        );
      }
    }

    if (filtered > 0) {
      log.info(
        { total: result.findings.length, qualified: findingsCreated, filtered },
        "Findings filtered by quality gate",
      );
    }

    if (result.findings.length === 0) {
      log.info({ programId: program.id }, "Hunt completed but no vulnerabilities found");
    }

    // Record outcome for learning context
    const strategy = detectHuntStrategy(program);
    await recordSecurityHuntOutcome({
      programId: program.id,
      programName: program.name,
      findingsReported: findingsCreated,
      findingsAccepted: 0,
      findingsDuplicate: 0,
      findingsRejected: 0,
      strategyUsed: strategy,
      timestamp: new Date().toISOString(),
    }).catch((err) => log.warn({ err }, "Failed to record hunt outcome"));

    // Update per-program notes with what was found/tried
    const vulnTypesFound = acceptedVulnTypes;
    await updateProgramNotes(program.id, {
      strategy,
      vulnTypesFound,
      areasInvestigated: [strategy],
    }).catch((err) => log.warn({ err }, "Failed to update program notes"));

    return { findingsCreated };
  } catch (err: any) {
    log.error({ err, programId: program.id }, "Program hunt error");
    // Record the failed outcome so it shows up in Recent Hunts
    await recordSecurityHuntOutcome({
      programId: program.id,
      programName: program.name,
      findingsReported: 0,
      findingsAccepted: 0,
      findingsDuplicate: 0,
      findingsRejected: 0,
      strategyUsed: "failed" as any,
      timestamp: new Date().toISOString(),
    }).catch(() => {});
    throw err;
  } finally {
    solving = false;
    // Update hunt tracking: count, miss streak (for exponential backoff), last hunted
    // Only increment miss streak for hunts that actually completed successfully.
    // Failed/incomplete hunts still update lastHuntedAt (to respect cooldown) but don't penalize.
    const currentProgram = db.select().from(schema.securityPrograms)
      .where(eq(schema.securityPrograms.id, program.id)).get();
    const prevHuntCount = currentProgram?.huntCount ?? 0;
    const prevMissStreak = currentProgram?.huntMissStreak ?? 0;

    const newMissStreak = !huntSucceeded
      ? prevMissStreak  // don't penalize for broken/incomplete hunts
      : findingsCreated > 0 ? 0 : prevMissStreak + 1;

    db.update(schema.securityPrograms)
      .set({
        lastHuntedAt: new Date(),
        huntCount: huntSucceeded ? prevHuntCount + 1 : prevHuntCount,
        huntMissStreak: newMissStreak,
        updatedAt: new Date(),
      })
      .where(eq(schema.securityPrograms.id, program.id))
      .run();

    if (huntSucceeded && newMissStreak > 0) {
      log.info(
        { programId: program.id, missStreak: newMissStreak, nextCooldownHours: getConfig().SECURITY_HUNT_COOLDOWN_HOURS * Math.pow(2, Math.min(newMissStreak, 6)) },
        "Program miss streak updated — next cooldown extended",
      );
    } else if (!huntSucceeded) {
      log.warn({ programId: program.id }, "Hunt did not complete successfully — miss streak unchanged");
    }
    await clearSecuritySolverStatus().catch(() => {});
  }
}

/**
 * Solve a specific finding — spawns Claude Opus to research the vulnerability
 * and draft a submission-ready report.
 */
export async function solveSecurityFinding(
  finding: SecurityFinding,
  trigger?: "auto" | "manual",
): Promise<void> {
  const db = getDb();

  if (solving) {
    throw new Error("Security solver is already busy");
  }

  const program = finding.programId
    ? db.select().from(schema.securityPrograms).where(eq(schema.securityPrograms.id, finding.programId)).get()
    : null;

  if (!program) {
    throw new Error(`No program found for finding ${finding.id}`);
  }

  solving = true;

  db.update(schema.securityFindings)
    .set({ status: "drafting", updatedAt: new Date() })
    .where(eq(schema.securityFindings.id, finding.id))
    .run();

  try {
    const result = await runFindingSolver(finding, program, trigger);

    if (result.success && result.findings.length > 0) {
      const report = result.findings[0];
      db.update(schema.securityFindings)
        .set({
          status: "report_ready",
          reportBody: report.reportBody,
          severity: report.severity as any,
          vulnerabilityType: report.vulnerabilityType,
          confidenceScore: report.confidence,
          updatedAt: new Date(),
        })
        .where(eq(schema.securityFindings.id, finding.id))
        .run();

      log.info({ findingId: finding.id }, "Finding report drafted — awaiting approval");
    } else {
      // Revert to report_ready so user can decide — never auto-fail
      db.update(schema.securityFindings)
        .set({
          status: "report_ready",
          retryCount: (finding.retryCount ?? 0) + 1,
          updatedAt: new Date(),
        })
        .where(eq(schema.securityFindings.id, finding.id))
        .run();

      log.warn({ findingId: finding.id, error: result.error }, "Finding solve unsuccessful — reverted to report_ready for user review");
    }
  } catch (err: any) {
    const classified = classifyError(err);
    // Revert to report_ready so user can decide — never auto-fail
    db.update(schema.securityFindings)
      .set({
        status: "report_ready",
        retryCount: (finding.retryCount ?? 0) + 1,
        updatedAt: new Date(),
      })
      .where(eq(schema.securityFindings.id, finding.id))
      .run();

    log.error({ err, findingId: finding.id }, "Finding solve error — reverted to report_ready for user review");
  } finally {
    solving = false;
    await clearSecuritySolverStatus().catch(() => {});
  }
}

/**
 * Force-stop the active security solver and clean up state.
 */
export async function forceStopSecuritySolver(): Promise<{ killed: boolean; resetFindingId: string | null }> {
  const killed = killActiveSecurityProcess();
  solving = false;

  const db = getDb();
  const stuck = db
    .select()
    .from(schema.securityFindings)
    .where(eq(schema.securityFindings.status, "drafting"))
    .limit(1)
    .get();

  let resetFindingId: string | null = null;
  if (stuck) {
    resetFindingId = stuck.id;
    db.update(schema.securityFindings)
      .set({ status: "validated", updatedAt: new Date() })
      .where(eq(schema.securityFindings.id, stuck.id))
      .run();
  }

  await clearSecuritySolverStatus();
  return { killed, resetFindingId };
}

/**
 * Pick the best validated finding for auto-solve.
 * Uses the full priority formula: severityMultiplier × confidence / (1 + difficulty)
 */
export function pickBestFinding(): SecurityFinding | null {
  const db = getDb();
  const findings = db
    .select()
    .from(schema.securityFindings)
    .where(eq(schema.securityFindings.status, "validated"))
    .all();

  if (findings.length === 0) return null;

  const SEVERITY_MULT: Record<string, number> = {
    critical: 5, high: 4, medium: 3, low: 2, informational: 1,
  };

  let best: SecurityFinding | null = null;
  let bestScore = -1;

  for (const f of findings) {
    const sevMult = SEVERITY_MULT[f.severity ?? "medium"] ?? 1;
    const confidence = f.confidenceScore ?? 0.5;
    let difficulty = 0.5;
    try {
      const notes = JSON.parse(f.analysisNotes || "{}");
      difficulty = notes.difficulty ?? 0.5;
    } catch {}

    const score = sevMult * confidence / (1 + difficulty);
    if (score > bestScore) {
      bestScore = score;
      best = f;
    }
  }

  return best;
}

/**
 * Pick the best program for auto-hunt using saturation-aware scoring.
 *
 * The goal: surface programs where we have the highest chance of finding something,
 * not just the ones with the biggest payouts. Programs that are newer and less
 * researched get a significant boost over established, heavily-hunted programs.
 *
 * Score = opportunityScore² × log₁₀(reward+1) × responseEfficiency × sourceCodeBoost
 *         × freshnessMult × saturationMult / (1 + missStreak)
 *
 * freshnessMult: Programs < 6 months old get 2x. Decays to 0.5x for programs > 4 years old.
 * saturationMult: Programs with few disclosed reports get a boost. Many disclosures = penalty.
 */
export function pickBestProgram(): SecurityProgram | null {
  const db = getDb();
  const config = getConfig();
  const baseCooldownMs = config.SECURITY_HUNT_COOLDOWN_HOURS * 60 * 60 * 1000;
  const minRewardCents = config.SECURITY_MIN_REWARD_CENTS;
  const excludeHandles = new Set(
    (config.EXCLUDE_SECURITY_PROGRAMS ?? []).map((h: string) => h.toLowerCase()),
  );

  const programs = db
    .select()
    .from(schema.securityPrograms)
    .where(eq(schema.securityPrograms.status, "active"))
    .all();

  let best: SecurityProgram | null = null;
  let bestScore = -1;
  const now = Date.now();

  for (const p of programs) {
    // Skip excluded programs (e.g. already hunted, or user doesn't want them)
    if (p.providerProgramId && excludeHandles.has(p.providerProgramId.toLowerCase())) continue;

    // Skip programs that have already been hunted
    if (p.lastHuntedAt) continue;

    // Skip programs below minimum reward threshold
    if ((p.rewardMaxCents ?? 0) < minRewardCents) continue;

    const missStreak = p.huntMissStreak ?? 0;

    try {
      const parsed = JSON.parse(p.scopeSummary || "{}");
      const opportunityScore = parsed.assessment?.opportunityScore ?? 0;
      if (opportunityScore === 0) continue; // not yet assessed

      const rewardMaxDollars = (p.rewardMaxCents ?? 0) / 100;
      const efficiency = p.responseEfficiency ?? 0.5; // default to 50% if unknown

      // Boost programs with source code in scope
      const scopes = parsed.scopes ?? [];
      const hasSourceCode = scopes.some(
        (s: any) =>
          s.assetType === "SOURCE_CODE" ||
          (s.assetIdentifier?.includes("github.com")) ||
          (s.assetIdentifier?.includes("gitlab.com")),
      );
      const sourceCodeBoost = hasSourceCode ? 1.5 : 1.0;

      // ── Freshness multiplier ──
      // Newer programs = less picked over = higher chance of finding something.
      // < 6 months: 2.0x  (prime hunting territory)
      // 6-12 months: 1.5x (still good)
      // 12-24 months: 1.0x (neutral)
      // 24-48 months: 0.7x (getting stale)
      // > 48 months: 0.5x  (heavily researched)
      let freshnessMult = 1.0;
      if (p.launchedAt) {
        const ageMonths = (now - p.launchedAt.getTime()) / (30.44 * 24 * 60 * 60 * 1000);
        if (ageMonths < 6) freshnessMult = 2.0;
        else if (ageMonths < 12) freshnessMult = 1.5;
        else if (ageMonths < 24) freshnessMult = 1.0;
        else if (ageMonths < 48) freshnessMult = 0.7;
        else freshnessMult = 0.5;
      }
      // If we don't know the launch date, assume it's been around a while (neutral)

      // ── Saturation multiplier ──
      // Fewer disclosed reports = less researcher attention = more low-hanging fruit.
      // 0-5 disclosures: 2.0x   (barely touched)
      // 5-20 disclosures: 1.5x  (lightly researched)
      // 20-50 disclosures: 1.0x (moderate)
      // 50-100 disclosures: 0.7x (well researched)
      // 100+ disclosures: 0.4x  (picked clean)
      let saturationMult = 1.0;
      const reportCount = p.disclosedReportCount;
      if (reportCount != null) {
        if (reportCount <= 5) saturationMult = 2.0;
        else if (reportCount <= 20) saturationMult = 1.5;
        else if (reportCount <= 50) saturationMult = 1.0;
        else if (reportCount <= 100) saturationMult = 0.7;
        else saturationMult = 0.4;
      }
      // If we don't know the count, stay neutral

      const score = 100
        * opportunityScore * opportunityScore
        * Math.log10(rewardMaxDollars + 1)
        * efficiency
        * sourceCodeBoost
        * freshnessMult
        * saturationMult
        / (1 + missStreak);

      if (score > bestScore) {
        bestScore = score;
        best = p;
      }
    } catch {}
  }

  return best;
}

// ── Adversarial Review ───────────────────────────────────────

interface AdversarialIssue {
  category: string;
  severity: "fatal" | "warning" | "info";
  description: string;
}

interface AdversarialRubric {
  exploitability: number;
  impactSeverity: number;
  evidenceQuality: number;
  novelty: number;
  scopeAlignment: number;
}

interface AdversarialReviewResult {
  verdict: "approve" | "reject";
  issues: AdversarialIssue[];
  reasoning: string;
  adjustedConfidence: number;
  rubric: AdversarialRubric;
}

function clampRubricScore(val: unknown): number {
  const n = Number(val);
  if (isNaN(n)) return 0;
  return Math.max(0, Math.min(3, Math.round(n)));
}

function computeConfidenceFromRubric(rubric: AdversarialRubric): number {
  const sum = rubric.exploitability + rubric.impactSeverity
            + rubric.evidenceQuality + rubric.novelty + rubric.scopeAlignment;
  return Math.round((sum / 15) * 100) / 100;
}

/**
 * Run an adversarial review on a report-ready finding.
 * A second Claude Opus instance critiques the report, looking for reasons a triager would reject it.
 */
async function runAdversarialReview(
  finding: SecurityFinding,
  program: SecurityProgram,
): Promise<AdversarialReviewResult> {
  const prompt = buildAdversarialReviewPrompt(finding, program);
  const raw = await runClaude(prompt, { model: "opus", timeoutMs: 300_000, temperature: 0 });

  // Extract JSON from response (handle possible markdown fences)
  const parsed = extractJsonWithKey<any>(raw, "verdict");
  if (!parsed) {
    throw new Error("Adversarial review returned no valid JSON");
  }

  // Validate and normalize — binary gate: approve or reject
  const verdict: "approve" | "reject" = parsed.verdict === "approve" ? "approve" : "reject";
  const issues: AdversarialIssue[] = Array.isArray(parsed.issues)
    ? parsed.issues.map((i: any) => ({
        category: i.category ?? "other",
        severity: ["fatal", "warning", "info"].includes(i.severity) ? i.severity : "warning",
        description: String(i.description ?? ""),
      }))
    : [];

  // Parse rubric scores and compute confidence deterministically
  const rubric: AdversarialRubric = {
    exploitability: clampRubricScore(parsed.rubric?.exploitability),
    impactSeverity: clampRubricScore(parsed.rubric?.impactSeverity),
    evidenceQuality: clampRubricScore(parsed.rubric?.evidenceQuality),
    novelty: clampRubricScore(parsed.rubric?.novelty),
    scopeAlignment: clampRubricScore(parsed.rubric?.scopeAlignment),
  };
  const adjustedConfidence = computeConfidenceFromRubric(rubric);

  // Any fatal issue must result in reject
  const hasFatal = issues.some((i) => i.severity === "fatal");
  const finalVerdict: "approve" | "reject" = hasFatal ? "reject" : verdict;

  return {
    verdict: finalVerdict,
    issues,
    reasoning: String(parsed.reasoning ?? ""),
    adjustedConfidence,
    rubric,
  };
}

/**
 * Process report_ready findings through adversarial review.
 * When programId is provided, only reviews findings from that program (used after hunts).
 * When omitted, reviews all report_ready findings (used for manual triggers / reassess).
 * Transitions findings to "reviewing" (passed) or "dismissed" (rejected).
 */
export async function processAdversarialQueue(programId?: string): Promise<void> {
  const db = getDb();
  const config = getConfig();

  const statusFilter = eq(schema.securityFindings.status, "report_ready");
  const whereClause = programId
    ? and(statusFilter, eq(schema.securityFindings.programId, programId))
    : statusFilter;

  const findings = db
    .select()
    .from(schema.securityFindings)
    .where(whereClause!)
    .all()
    .filter((f) => {
      // Skip findings that already have an adversarial review —
      // they stay report_ready for the user to manually act on
      try {
        const notes = JSON.parse(f.analysisNotes || "{}");
        return !notes.adversarialReview;
      } catch {
        return true;
      }
    });

  if (findings.length === 0) return;

  log.info({ count: findings.length }, "Processing adversarial review queue");

  await writeAdversarialReviewStatus({
    active: true,
    total: findings.length,
    completed: 0,
    startedAt: new Date().toISOString(),
  });

  let completed = 0;

  try {
  for (const finding of findings) {
    // Check for cancellation
    const currentStatus = await readAdversarialReviewStatus();
    if (currentStatus.cancelled) {
      log.info("Adversarial review cancelled");
      break;
    }

    const program = finding.programId
      ? db.select().from(schema.securityPrograms).where(eq(schema.securityPrograms.id, finding.programId)).get()
      : null;

    if (!program) {
      log.warn({ findingId: finding.id }, "Skipping adversarial review — no associated program");
      completed++;
      continue;
    }

    try {
      await writeAdversarialReviewStatus({
        active: true,
        total: findings.length,
        completed,
        currentFindingId: finding.id,
        currentFindingTitle: finding.title,
        startedAt: new Date().toISOString(),
      });

      // Parse existing notes to check for prior review
      let existingNotes: Record<string, any> = {};
      try {
        existingNotes = JSON.parse(finding.analysisNotes || "{}");
      } catch {}

      log.info({ findingId: finding.id, title: finding.title }, "Running adversarial review");
      const review = await runAdversarialReview(finding, program);

      // Preserve prior reviews in history
      const reviewHistory = existingNotes.reviewHistory ?? [];
      if (existingNotes.adversarialReview) {
        reviewHistory.push(existingNotes.adversarialReview);
      }

      const updatedNotes = JSON.stringify({
        ...existingNotes,
        adversarialReview: {
          verdict: review.verdict,
          issues: review.issues,
          reasoning: review.reasoning,
          adjustedConfidence: review.adjustedConfidence,
          rubric: review.rubric,
          reviewedAt: new Date().toISOString(),
        },
        reviewHistory,
      });

      if (review.verdict === "approve") {
        // Phase 2: Tool-enabled verification — actually run the PoC
        // Retry once if verification returns false but raw output suggests approval (JSON parse issue)
        log.info({ findingId: finding.id }, "Text review passed — running tool-enabled verification");
        let verificationPassed = true;
        let verificationNotes = "";
        const MAX_VERIFY_ATTEMPTS = 2;
        for (let attempt = 1; attempt <= MAX_VERIFY_ATTEMPTS; attempt++) {
          try {
            const verification = await spawnAdversarialVerification(finding, program);
            verificationPassed = verification.verified;
            verificationNotes = verification.output.slice(-500);
            if (!verificationPassed && attempt < MAX_VERIFY_ATTEMPTS) {
              // Check if the raw output suggests approval despite structured parse failure
              const rawApproval = /"verified"\s*:\s*true/i.test(verification.output)
                               || /"recommendation"\s*:\s*"approve"/i.test(verification.output);
              if (rawApproval) {
                log.warn({ findingId: finding.id, attempt }, "Verification returned verified:false but raw output suggests approval — retrying");
                continue;
              }
            }
            if (!verificationPassed) {
              log.info({ findingId: finding.id }, "Finding failed tool-enabled verification — PoC did not reproduce");
            }
            break;
          } catch (verifyErr: any) {
            if (attempt < MAX_VERIFY_ATTEMPTS) {
              log.warn({ err: verifyErr, findingId: finding.id, attempt }, "Tool-enabled verification errored — retrying");
              continue;
            }
            // If verification fails to run on final attempt, still proceed with text-only review
            log.warn({ err: verifyErr, findingId: finding.id }, "Tool-enabled verification errored — proceeding with text-only review");
            break;
          }
        }

        const finalNotes = JSON.stringify({
          ...JSON.parse(updatedNotes),
          toolVerification: {
            verified: verificationPassed,
            notes: verificationNotes,
            verifiedAt: new Date().toISOString(),
          },
        });

        if (!verificationPassed) {
          // PoC didn't reproduce — dismiss so it won't be re-reviewed
          db.update(schema.securityFindings)
            .set({
              status: "bot_rejected",
              confidenceScore: Math.min(review.adjustedConfidence, 0.5), // penalize
              analysisNotes: finalNotes,
              updatedAt: new Date(),
            })
            .where(eq(schema.securityFindings.id, finding.id))
            .run();

          log.info(
            { findingId: finding.id },
            "Finding dismissed — tool verification failed to reproduce PoC",
          );
          recordNearMiss({
            programId: program.id,
            title: finding.title,
            vulnType: finding.vulnerabilityType ?? "unknown",
            reason: "adversarial_reject",
            reviewFeedback: "PoC failed to reproduce in tool-enabled verification",
            timestamp: new Date().toISOString(),
          }).catch(() => {});
        } else {
          // Boost confidence when tool verification independently confirms the finding
          const verifiedConfidence = Math.min(
            review.adjustedConfidence + 0.15,
            0.85, // cap — still leave room for human judgment
          );
          db.update(schema.securityFindings)
            .set({
              status: "reviewing",
              confidenceScore: verifiedConfidence,
              analysisNotes: finalNotes,
              updatedAt: new Date(),
            })
            .where(eq(schema.securityFindings.id, finding.id))
            .run();

          log.info(
            { findingId: finding.id, confidence: verifiedConfidence, rubricConfidence: review.adjustedConfidence, verified: true },
            "Finding passed adversarial review + tool verification — awaiting manual approval",
          );
        }
      } else {
        // Rejected by text review — move to bot_rejected so it won't be re-reviewed
        db.update(schema.securityFindings)
          .set({
            status: "bot_rejected",
            confidenceScore: review.adjustedConfidence,
            analysisNotes: updatedNotes,
            updatedAt: new Date(),
          })
          .where(eq(schema.securityFindings.id, finding.id))
          .run();

        log.info(
          { findingId: finding.id, reasoning: review.reasoning },
          "Finding dismissed by adversarial review",
        );
        recordNearMiss({
          programId: program.id,
          title: finding.title,
          vulnType: finding.vulnerabilityType ?? "unknown",
          reason: "adversarial_reject",
          reviewFeedback: review.reasoning,
          timestamp: new Date().toISOString(),
        }).catch(() => {});
      }
    } catch (err: any) {
      log.error({ err, findingId: finding.id }, "Adversarial review failed");
    }

    completed++;
  }
  } finally {
    await clearAdversarialReviewStatus().catch(() => {});
  }
}
