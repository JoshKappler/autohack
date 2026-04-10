import { randomBytes } from "node:crypto";
import { readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { eq, desc, and, or, isNull, lt } from "drizzle-orm";
import { getDb, schema, getConfig, createLogger, generateTraceId, classifyError, extractJsonWithKey, recordSecurityHuntOutcome, recordNearMiss, updateProgramNotes, getSecurityLearningContext, getSecurityProgramContext, type SecurityFinding, type SecurityProgram } from "@bounty/core";
import { fetchProgramPolicy, fetchProgramSignalRequirement, fetchAllDisclosedReports, prepareSubmission, submitReport, fetchProgramScopes } from "@bounty/security-discovery";
import { runProgramHunt, runFindingSolver, killActiveSecurityProcess, detectHuntStrategy, prepareReviewWorkspace, spawnComprehensiveReview, deverbosifyReport, EXCLUDED_VULN_TYPES, type ReviewContext } from "./claude-runner";
import { clearSecuritySolverStatus, writeAdversarialReviewStatus, clearAdversarialReviewStatus, readAdversarialReviewStatus, cancelAdversarialReview } from "./status";

const log = createLogger("security-solver");

let solving = false;

// Cross-process lock file to prevent concurrent hunts from orchestrator + dashboard
const HUNT_LOCK_FILE = join(process.env.PROJECT_ROOT || process.cwd(), "data", "security-hunt.lock");

function acquireHuntLock(): boolean {
  // Check existing lock
  try {
    const raw = readFileSync(HUNT_LOCK_FILE, "utf-8");
    const lock = JSON.parse(raw);

    // If we (same PID) hold the lock, it's stale from a previous crashed hunt
    if (lock.pid === process.pid) {
      log.info("Reclaiming own stale hunt lock from previous run");
    } else {
      // Check if the locking process is still alive
      try {
        process.kill(lock.pid, 0); // signal 0 = just check existence
        // Process is alive — lock is held
        return false;
      } catch {
        // Process is dead — stale lock, we can take it
        log.info({ stalePid: lock.pid }, "Removing stale hunt lock");
      }
    }
  } catch {
    // No lock file or invalid — safe to acquire
  }

  try {
    writeFileSync(HUNT_LOCK_FILE, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
    return true;
  } catch {
    return false;
  }
}

function releaseHuntLock(): void {
  try { unlinkSync(HUNT_LOCK_FILE); } catch {}
}

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

  if (!acquireHuntLock()) {
    throw new Error("Security solver is already busy (another process holds the lock)");
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
    const EXCLUDED_TYPES = EXCLUDED_VULN_TYPES;

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
    releaseHuntLock();
    await clearSecuritySolverStatus().catch(() => {});

    // Update hunt tracking: count, miss streak (for exponential backoff), last hunted.
    // Wrapped in try/catch so a DB error here can't crash the orchestrator loop.
    try {
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
    } catch (finallyErr) {
      log.error({ err: finallyErr, programId: program.id }, "Failed to update hunt tracking in finally block");
    }
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

  if (!acquireHuntLock()) {
    throw new Error("Security solver is already busy (another process holds the lock)");
  }

  const program = finding.programId
    ? db.select().from(schema.securityPrograms).where(eq(schema.securityPrograms.id, finding.programId)).get()
    : null;

  if (!program) {
    releaseHuntLock();
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
    releaseHuntLock();
    await clearSecuritySolverStatus().catch(() => {});
  }
}

/**
 * Force-stop the active security solver and clean up state.
 */
export async function forceStopSecuritySolver(): Promise<{ killed: boolean; resetFindingId: string | null }> {
  const killed = killActiveSecurityProcess();
  solving = false;
  releaseHuntLock();

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
 * Score a single program for hunt priority using saturation-aware scoring.
 *
 * Score = opportunityScore² × log₁₀(reward+1) × responseEfficiency × sourceCodeBoost
 *         × freshnessMult × saturationMult / (1 + missStreak)
 *
 * Returns the score, or null if the program can't be scored (no assessment).
 */
export function scoreProgram(p: SecurityProgram): number | null {
  const now = Date.now();
  try {
    const parsed = JSON.parse(p.scopeSummary || "{}");
    const opportunityScore = parsed.assessment?.opportunityScore ?? 0;
    if (opportunityScore === 0) return null; // not yet assessed

    const rewardMaxDollars = (p.rewardMaxCents ?? 0) / 100;
    const efficiency = p.responseEfficiency ?? 0.5;
    const missStreak = p.huntMissStreak ?? 0;

    // Boost programs with source code in scope
    const scopes = parsed.scopes ?? [];
    const hasSourceCode = scopes.some(
      (s: any) =>
        s.assetType === "SOURCE_CODE" ||
        (s.assetIdentifier?.includes("github.com")) ||
        (s.assetIdentifier?.includes("gitlab.com")),
    );
    const sourceCodeBoost = hasSourceCode ? 1.5 : 1.0;

    // Boost low-barrier platforms (no ID verification, no reputation gate)
    const lowBarrierBoost = p.provider === "huntr" ? 1.5 : 1.0;

    // Freshness: newer programs = less picked over
    let freshnessMult = 1.0;
    if (p.launchedAt) {
      const ageMonths = (now - p.launchedAt.getTime()) / (30.44 * 24 * 60 * 60 * 1000);
      if (ageMonths < 6) freshnessMult = 2.0;
      else if (ageMonths < 12) freshnessMult = 1.5;
      else if (ageMonths < 24) freshnessMult = 1.0;
      else if (ageMonths < 48) freshnessMult = 0.7;
      else freshnessMult = 0.5;
    }

    // Saturation: fewer disclosed reports = more low-hanging fruit
    let saturationMult = 1.0;
    const reportCount = p.disclosedReportCount;
    if (reportCount != null) {
      if (reportCount <= 5) saturationMult = 2.0;
      else if (reportCount <= 20) saturationMult = 1.5;
      else if (reportCount <= 50) saturationMult = 1.0;
      else if (reportCount <= 100) saturationMult = 0.7;
      else saturationMult = 0.4;
    }

    return 100
      * opportunityScore * opportunityScore
      * Math.log10(rewardMaxDollars + 1)
      * efficiency
      * sourceCodeBoost
      * lowBarrierBoost
      * freshnessMult
      * saturationMult
      / (1 + missStreak);
  } catch {
    return null;
  }
}

export interface RankedProgram {
  program: SecurityProgram;
  score: number;
}

/**
 * Rank all eligible programs for auto-hunt, sorted best-first.
 *
 * This is the single source of truth for hunt ordering — used by pickBestProgram(),
 * the auto-hunt loop, and the dashboard display.
 *
 * Filters applied:
 * - Excluded program handles (EXCLUDE_SECURITY_PROGRAMS)
 * - Signal-required programs (when SKIP_SIGNAL_REQUIRED is true)
 * - Cooldown (exponential backoff based on miss streak)
 * - Minimum reward threshold (SECURITY_MIN_REWARD_CENTS)
 * - Must have an assessment (opportunityScore > 0)
 */
export function rankEligiblePrograms(): RankedProgram[] {
  const db = getDb();
  const config = getConfig();
  const baseCooldownMs = config.SECURITY_HUNT_COOLDOWN_HOURS * 60 * 60 * 1000;
  const minRewardCents = config.SECURITY_MIN_REWARD_CENTS;
  const excludeHandles = new Set(
    (config.EXCLUDE_SECURITY_PROGRAMS ?? []).map((h: string) => h.toLowerCase()),
  );
  const now = Date.now();

  const programs = db
    .select()
    .from(schema.securityPrograms)
    .where(eq(schema.securityPrograms.status, "active"))
    .all();

  const ranked: RankedProgram[] = [];

  for (const p of programs) {
    if (p.providerProgramId && excludeHandles.has(p.providerProgramId.toLowerCase())) continue;
    if (p.requiresSignal && config.SKIP_SIGNAL_REQUIRED) continue;

    // Skip previously hunted programs entirely (user wants to try everything once first)
    if (p.lastHuntedAt && config.SKIP_PREVIOUSLY_HUNTED) continue;

    // Cooldown with exponential backoff (only applies when re-hunting is enabled)
    if (p.lastHuntedAt) {
      const missStreak = p.huntMissStreak ?? 0;
      const cooldownMs = baseCooldownMs * Math.pow(2, Math.min(missStreak, 6));
      if (now - p.lastHuntedAt.getTime() < cooldownMs) continue;
    }

    if ((p.rewardMaxCents ?? 0) < minRewardCents) continue;

    // Skip web-only programs (no source code in scope)
    if (config.SKIP_WEB_ONLY_PROGRAMS) {
      const hasSourceCode = (() => {
        try {
          const parsed = JSON.parse(p.scopeSummary || "{}");
          const scopes = parsed.scopes ?? [];
          return scopes.some(
            (s: any) =>
              s.assetType === "SOURCE_CODE" ||
              (s.assetIdentifier?.includes("github.com")) ||
              (s.assetIdentifier?.includes("gitlab.com")),
          );
        } catch {
          return false;
        }
      })();
      if (!hasSourceCode) continue;
    }

    const score = scoreProgram(p);
    if (score === null || score === 0) continue;

    ranked.push({ program: p, score });
  }

  ranked.sort((a, b) => b.score - a.score);
  return ranked;
}

/**
 * Pick the best program for auto-hunt.
 * Returns the top-ranked eligible program, or null if none are eligible.
 */
export function pickBestProgram(): SecurityProgram | null {
  const ranked = rankEligiblePrograms();
  return ranked.length > 0 ? ranked[0].program : null;
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
  recommendation: "submit" | "submit_cautiously" | "dont_submit";
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
 * Fetch fresh program page context from HackerOne for use in adversarial review.
 * Returns policy text, disclosed reports, and signal requirement status.
 */
async function fetchProgramPageContext(program: SecurityProgram): Promise<{
  policy: string | null;
  disclosedReports: Array<{ title: string; severity: string; disclosedAt: string }>;
  disclosedReportCount: number;
  requiresSignal: boolean;
}> {
  const handle = program.providerProgramId;
  if (!handle || program.provider !== "hackerone") {
    return { policy: null, disclosedReports: [], disclosedReportCount: 0, requiresSignal: false };
  }

  const [policyResult, signalResult] = await Promise.allSettled([
    fetchProgramPolicy(handle),
    fetchProgramSignalRequirement(handle),
  ]);

  const policyData = policyResult.status === "fulfilled" ? policyResult.value : { policy: null, disclosedReports: [], disclosedReportCount: 0 };
  const requiresSignal = signalResult.status === "fulfilled" ? signalResult.value : null;

  // Update DB if signal requirement changed (only on conclusive results)
  if (requiresSignal !== null && requiresSignal !== (program.requiresSignal ?? false)) {
    const db = getDb();
    db.update(schema.securityPrograms)
      .set({ requiresSignal, updatedAt: new Date() })
      .where(eq(schema.securityPrograms.id, program.id))
      .run();
    log.info({ programId: program.id, requiresSignal }, "Updated signal requirement from adversarial review fetch");
  }

  return { ...policyData, requiresSignal: requiresSignal ?? (program.requiresSignal ?? false) };
}

/**
 * Build batch context string for cross-referencing sibling findings in the same review queue.
 * Also includes findings that were filtered by the quality gate during this hunt.
 */
function buildBatchContext(currentFindingId: string, allFindings: SecurityFinding[], programId?: string): string {
  const parts: string[] = [];

  const siblings = allFindings.filter((f) => f.id !== currentFindingId);
  if (siblings.length > 0) {
    const lines = siblings.map((f) =>
      `- [${f.severity}] "${f.title}" (confidence: ${f.confidenceScore}, status: ${f.status})`
    );
    parts.push(`## Other Findings in This Review Batch\nThese are other findings being reviewed alongside this one. Consider whether any overlap, contradict, or provide context for the current finding:\n${lines.join("\n")}`);
  }

  // Include recently quality-gate-filtered findings from the same program
  if (programId) {
    const db = getDb();
    const recentBotRejected = db
      .select({ title: schema.securityFindings.title, severity: schema.securityFindings.severity, vulnerabilityType: schema.securityFindings.vulnerabilityType })
      .from(schema.securityFindings)
      .where(and(eq(schema.securityFindings.programId, programId), eq(schema.securityFindings.status, "bot_rejected")))
      .all()
      .slice(-5);
    if (recentBotRejected.length > 0) {
      const lines = recentBotRejected.map(f => `- [${f.severity}] "${f.title}" (${f.vulnerabilityType ?? "?"})`);
      parts.push(`## Previously Rejected Findings on This Program\nThese findings from prior hunts were rejected by adversarial review. Similar findings should be treated with extra skepticism:\n${lines.join("\n")}`);
    }
  }

  return parts.length > 0 ? "\n" + parts.join("\n\n") + "\n" : "";
}

/**
 * Process report_ready findings through comprehensive adversarial review.
 * When programId is provided, only reviews findings from that program (used after hunts).
 * When omitted, reviews all report_ready findings (used for manual triggers / reassess).
 * Uses a single tool-enabled Claude session per finding that verifies all claims.
 * Transitions findings to "reviewing" (passed) or "bot_rejected" (rejected).
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

      log.info({ findingId: finding.id, title: finding.title }, "Running comprehensive adversarial review");

      // Step 1: Prepare review workspace (clone target repo if possible)
      const workspace = await prepareReviewWorkspace(finding as SecurityFinding, program);

      // Step 2: Fetch comprehensive context
      const programPage = await fetchProgramPageContext(program);
      const handle = program.providerProgramId;
      let allDisclosedReports = programPage.disclosedReports;
      if (handle && program.provider === "hackerone") {
        try {
          allDisclosedReports = await fetchAllDisclosedReports(handle, 200);
        } catch {
          log.debug({ handle }, "Failed to fetch paginated disclosed reports, using basic set");
        }
      }

      const learningContext = await getSecurityLearningContext();
      const programContext = await getSecurityProgramContext(program.id);
      const batchContext = buildBatchContext(finding.id, findings, finding.programId ?? undefined);

      const reviewContext: ReviewContext = {
        workspacePath: workspace.workspacePath,
        repoCloned: workspace.repoCloned,
        repoPath: workspace.repoPath,
        disclosedReports: allDisclosedReports,
        policy: programPage.policy,
        requiresSignal: programPage.requiresSignal,
        learningContext: learningContext ?? "",
        programContext: programContext ?? "",
        batchContext,
      };

      // Step 3: Run single comprehensive tool-enabled review
      const { output } = await spawnComprehensiveReview(finding as SecurityFinding, program, reviewContext);

      // Step 4: Parse the review result
      const parsed = extractJsonWithKey<any>(output, "verdict");
      if (!parsed) {
        throw new Error("Comprehensive review returned no valid JSON");
      }

      const verdict: "approve" | "reject" = parsed.verdict === "approve" ? "approve" : "reject";
      const validRecs = ["submit", "submit_cautiously", "dont_submit"];
      let recommendation: "submit" | "submit_cautiously" | "dont_submit";
      if (validRecs.includes(parsed.recommendation)) {
        recommendation = parsed.recommendation;
      } else {
        recommendation = verdict === "approve" ? "submit_cautiously" : "dont_submit";
      }

      const issues: AdversarialIssue[] = Array.isArray(parsed.issues)
        ? parsed.issues.map((i: any) => ({
            category: i.category ?? "other",
            severity: ["fatal", "warning", "info"].includes(i.severity) ? i.severity : "warning",
            description: String(i.description ?? ""),
          }))
        : [];

      const rubric: AdversarialRubric = {
        exploitability: clampRubricScore(parsed.rubric?.exploitability),
        impactSeverity: clampRubricScore(parsed.rubric?.impactSeverity),
        evidenceQuality: clampRubricScore(parsed.rubric?.evidenceQuality),
        novelty: clampRubricScore(parsed.rubric?.novelty),
        scopeAlignment: clampRubricScore(parsed.rubric?.scopeAlignment),
      };
      const adjustedConfidence = computeConfidenceFromRubric(rubric);

      // Auto-reject gates:
      // 1. Any fatal issue forces reject
      const hasFatal = issues.some((i) => i.severity === "fatal");
      // 2. bet100 check (soft signal — only rejects if verdict is also "reject")
      const bet100 = parsed.bet100 === true;
      // 3. Rubric total must meet minimum threshold
      const rubricTotal = rubric.exploitability + rubric.impactSeverity + rubric.evidenceQuality + rubric.novelty + rubric.scopeAlignment;
      const minRubricScore = config.SECURITY_MIN_RUBRIC_SCORE;
      const rubricTooLow = rubricTotal < minRubricScore;

      let finalVerdict = hasFatal ? "reject" : verdict;
      let finalRecommendation: "submit" | "submit_cautiously" | "dont_submit";
      if (hasFatal || rubricTooLow) {
        // Hard gates: fatal issues or very low rubric score
        finalRecommendation = "dont_submit";
        if (hasFatal) finalVerdict = "reject";
      } else if (!bet100 && verdict === "reject") {
        // bet100=false only forces reject when reviewer also rejected
        finalRecommendation = "dont_submit";
      } else {
        // submit_cautiously passes through to manual review instead of auto-rejecting
        finalRecommendation = recommendation;
      }

      if (hasFatal) {
        log.info({ findingId: finding.id, rubricTotal }, "Finding rejected: fatal issue identified");
      }
      if (rubricTooLow && !hasFatal) {
        log.info({ findingId: finding.id, rubricTotal, minRubricScore }, "Finding auto-rejected: rubric score below threshold");
      }
      if (!bet100 && verdict === "reject" && !hasFatal && !rubricTooLow) {
        log.info({ findingId: finding.id }, "Finding rejected: reviewer would not bet $100 and verdict is reject");
      }

      // Preserve prior reviews in history
      const reviewHistory = existingNotes.reviewHistory ?? [];
      if (existingNotes.adversarialReview) {
        reviewHistory.push(existingNotes.adversarialReview);
      }

      const updatedNotes = JSON.stringify({
        ...existingNotes,
        adversarialReview: {
          verdict: finalVerdict,
          recommendation: finalRecommendation,
          bet100,
          rubricTotal,
          issues,
          reasoning: String(parsed.reasoning ?? ""),
          adjustedConfidence,
          rubric,
          reviewedAt: new Date().toISOString(),
          toolEnabled: true,
          repoCloned: workspace.repoCloned,
        },
        reviewHistory,
      });

      // Step 5: Gate on recommendation
      if (finalRecommendation === "dont_submit" || finalVerdict === "reject") {
        db.update(schema.securityFindings)
          .set({
            status: "bot_rejected",
            confidenceScore: adjustedConfidence,
            analysisNotes: updatedNotes,
            updatedAt: new Date(),
          })
          .where(eq(schema.securityFindings.id, finding.id))
          .run();

        log.info(
          { findingId: finding.id, verdict: finalVerdict, recommendation: finalRecommendation, reasoning: parsed.reasoning },
          "Finding rejected by comprehensive review",
        );
        recordNearMiss({
          programId: program.id,
          title: finding.title,
          vulnType: finding.vulnerabilityType ?? "unknown",
          reason: "adversarial_reject",
          reviewFeedback: `[${finalRecommendation}] ${parsed.reasoning ?? ""}`,
          timestamp: new Date().toISOString(),
        }).catch(() => {});
        // Record rejection in program notes so future hunts know this vuln type was rejected here
        if (finding.vulnerabilityType) {
          updateProgramNotes(program.id, {
            vulnTypesRejected: [finding.vulnerabilityType],
          }).catch(() => {});
        }
      } else {
        // Approved — run separate deverbosification pass and apply corrected severity
        const correctedSeverity = parsed.correctedSeverity;
        const updateFields: Record<string, any> = {
          status: "reviewing",
          confidenceScore: Math.min(adjustedConfidence + 0.1, 0.85),
          analysisNotes: updatedNotes,
          updatedAt: new Date(),
        };
        if (correctedSeverity && ["critical", "high", "medium"].includes(correctedSeverity) && correctedSeverity !== finding.severity) {
          updateFields.severity = correctedSeverity;
          log.info({ findingId: finding.id, oldSeverity: finding.severity, newSeverity: correctedSeverity }, "Severity corrected by reviewer");
        }

        // Deverbosify the report in a separate Sonnet call (doesn't contaminate reviewer's judgment)
        if (finding.reportBody) {
          try {
            const cleaned = await deverbosifyReport(finding.reportBody);
            if (cleaned !== finding.reportBody) {
              updateFields.reportBody = cleaned;
              log.info({ findingId: finding.id }, "Report body deverbosified in separate pass");
            }
          } catch (err) {
            log.warn({ err, findingId: finding.id }, "Deverbosification failed, keeping original");
          }
        }

        db.update(schema.securityFindings)
          .set(updateFields)
          .where(eq(schema.securityFindings.id, finding.id))
          .run();

        log.info(
          { findingId: finding.id, confidence: updateFields.confidenceScore, recommendation: finalRecommendation },
          finalRecommendation === "submit_cautiously"
            ? "Finding passed review but flagged as CAUTIOUS — awaiting manual approval"
            : "Finding passed comprehensive review — awaiting manual approval",
        );

        // Record approval in program notes so future hunts know this vuln type was found here
        if (finding.vulnerabilityType) {
          updateProgramNotes(program.id, {
            vulnTypesFound: [finding.vulnerabilityType],
          }).catch(() => {});
        }

        // Auto-submit if enabled and recommendation is "submit" (not "submit_cautiously")
        // Only HackerOne supports programmatic submission — other providers require manual submission
        if (config.SECURITY_AUTO_SUBMIT && finalRecommendation === "submit" && program.provider === "hackerone" && program.providerProgramId) {
          try {
            const handle = program.providerProgramId;
            const scopes = await fetchProgramScopes(handle);
            const reportBody = updateFields.reportBody ?? finding.reportBody ?? "";
            const payload = await prepareSubmission({
              teamHandle: handle,
              finding: {
                title: finding.title,
                reportBody,
                severity: updateFields.severity ?? finding.severity ?? "medium",
                vulnerabilityType: finding.vulnerabilityType ?? undefined,
                targetAsset: finding.targetAsset ?? undefined,
              },
              scopes,
              policy: reviewContext.policy ?? undefined,
            });

            // Don't submit if policy exclusion was detected
            if (payload.policyExcluded) {
              log.warn({ findingId: finding.id }, "Auto-submit blocked: policy exclusion detected");
            } else {
              const result = await submitReport({ teamHandle: handle, payload });
              db.update(schema.securityFindings)
                .set({
                  status: "submitted",
                  reportId: result.reportId,
                  reportUrl: result.reportUrl,
                  submittedAt: new Date(),
                  updatedAt: new Date(),
                })
                .where(eq(schema.securityFindings.id, finding.id))
                .run();
              log.info({ findingId: finding.id, reportId: result.reportId, reportUrl: result.reportUrl }, "Finding auto-submitted to HackerOne");
            }
          } catch (submitErr) {
            log.error({ err: submitErr, findingId: finding.id }, "Auto-submit failed — finding remains in reviewing status for manual submission");
          }
        }
      }

      // Clean up review workspace
      await rm(workspace.workspacePath, { recursive: true, force: true }).catch(() => {});
    } catch (err: any) {
      log.error({ err, findingId: finding.id }, "Comprehensive adversarial review failed");
      // Clean up on error too
      await rm("/tmp/security-review", { recursive: true, force: true }).catch(() => {});
    }

    completed++;
  }
  } finally {
    await clearAdversarialReviewStatus().catch(() => {});
  }
}
