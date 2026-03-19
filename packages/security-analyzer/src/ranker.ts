import { eq, sql, desc } from "drizzle-orm";
import {
  getDb,
  schema,
  createLogger,
  generateTraceId,
  classifyError,
  type SecurityProgram,
  type SecurityFinding,
} from "@algora/core";
import { assessProgram, assessFinding } from "./assessor";

const log = createLogger("security-ranker");

/**
 * Analyze a security program — assess its scope for vulnerability opportunity.
 * Updates the program's assessment data in the database.
 */
export async function analyzeProgram(program: SecurityProgram): Promise<void> {
  const db = getDb();

  log.info({ name: program.name, id: program.id }, "Analyzing program");

  try {
    const result = await assessProgram(program);

    // Store assessment in scopeSummary alongside existing scope data, policy, and disclosed reports
    let existing: any = {};
    try {
      const parsed = JSON.parse(program.scopeSummary || "{}");
      // Handle both old array format and new object format
      if (Array.isArray(parsed)) {
        existing = { scopes: parsed };
      } else {
        existing = parsed;
      }
    } catch {}

    const enrichedSummary = JSON.stringify({
      ...existing,
      scopes: existing.scopes ?? [],
      assessment: {
        opportunityScore: result.opportunityScore,
        targetCount: result.targetCount,
        topTargets: result.topTargets,
        techStack: result.techStack,
        attackSurface: result.attackSurface,
        hasSourceCode: result.hasSourceCode,
        recommendedApproach: result.recommendedApproach,
        assessedAt: new Date().toISOString(),
      },
    });

    db.update(schema.securityPrograms)
      .set({
        scopeSummary: enrichedSummary,
        updatedAt: new Date(),
      })
      .where(eq(schema.securityPrograms.id, program.id))
      .run();

    log.info(
      { name: program.name, opportunityScore: result.opportunityScore },
      "Program analysis complete",
    );
  } catch (err: any) {
    log.error({ err, name: program.name }, "Program analysis failed");
    throw err;
  }
}

/**
 * Analyze and rank a security finding — assess difficulty, confidence, severity.
 */
export async function analyzeAndRankFinding(finding: SecurityFinding): Promise<void> {
  const db = getDb();
  const traceId = generateTraceId();

  // Get the program for context
  const program = finding.programId
    ? db.select().from(schema.securityPrograms).where(eq(schema.securityPrograms.id, finding.programId)).get()
    : null;

  if (!program) {
    log.warn({ findingId: finding.id }, "Finding has no associated program, skipping");
    return;
  }

  // Update status to analyzing
  db.update(schema.securityFindings)
    .set({ status: "analyzing", traceId, updatedAt: new Date() })
    .where(eq(schema.securityFindings.id, finding.id))
    .run();

  try {
    const result = await assessFinding(finding, program);

    // Priority: high confidence + high severity + low difficulty = best opportunity
    const severityMultiplier: Record<string, number> = {
      critical: 5,
      high: 4,
      medium: 3,
      low: 2,
      informational: 1,
    };
    const sevMult = severityMultiplier[result.severity] ?? 1;

    db.update(schema.securityFindings)
      .set({
        status: "validated",
        severity: result.severity,
        vulnerabilityType: result.vulnerabilityType,
        confidenceScore: result.confidence,
        analysisNotes: JSON.stringify({
          difficulty: result.difficulty,
          approach: result.approach,
          riskFactors: result.riskFactors,
          estimatedRewardCents: result.estimatedRewardCents,
          severityMultiplier: sevMult,
          traceId,
        }),
        updatedAt: new Date(),
      })
      .where(eq(schema.securityFindings.id, finding.id))
      .run();

    log.info(
      {
        traceId,
        title: finding.title,
        confidence: result.confidence,
        severity: result.severity,
        difficulty: result.difficulty,
      },
      "Finding analysis complete",
    );
  } catch (err: any) {
    const classified = classifyError(err);
    log.error({ traceId, err, findingId: finding.id }, "Finding analysis failed");

    db.update(schema.securityFindings)
      .set({
        status: "failed",
        retryCount: (finding.retryCount ?? 0) + 1,
        analysisNotes: JSON.stringify({
          error: classified.message,
          errorCategory: classified.category,
          traceId,
        }),
        updatedAt: new Date(),
      })
      .where(eq(schema.securityFindings.id, finding.id))
      .run();

    throw err;
  }
}

/**
 * Process the analysis queue for security programs.
 * Analyzes all unassessed active programs.
 */
export async function processSecurityProgramQueue(): Promise<number> {
  const db = getDb();
  let analyzed = 0;

  // Get programs that haven't been assessed yet (no assessment in scopeSummary)
  const programs = db
    .select()
    .from(schema.securityPrograms)
    .where(eq(schema.securityPrograms.status, "active"))
    .orderBy(desc(schema.securityPrograms.rewardMaxCents))
    .all();

  const unassessed = programs.filter((program) => {
    try {
      const parsed = JSON.parse(program.scopeSummary || "{}");
      return parsed.assessment?.opportunityScore == null;
    } catch {
      return true;
    }
  });

  // Process in concurrent batches of 5
  const CONCURRENCY = 5;
  for (let i = 0; i < unassessed.length; i += CONCURRENCY) {
    const batch = unassessed.slice(i, i + CONCURRENCY);
    const results = await Promise.allSettled(
      batch.map((program) => analyzeProgram(program)),
    );

    for (let j = 0; j < results.length; j++) {
      if (results[j].status === "fulfilled") {
        analyzed++;
      } else {
        log.error({ err: (results[j] as PromiseRejectedResult).reason, programId: batch[j].id }, "Error analyzing program, continuing");
      }
    }
  }

  return analyzed;
}

/**
 * Process the analysis queue for security findings.
 * Analyzes all discovered findings, highest confidence first.
 */
export async function processSecurityFindingQueue(): Promise<number> {
  const db = getDb();
  let analyzed = 0;

  const pending = db
    .select()
    .from(schema.securityFindings)
    .where(eq(schema.securityFindings.status, "discovered"))
    .all();

  // Process in concurrent batches of 5
  const CONCURRENCY = 5;
  for (let i = 0; i < pending.length; i += CONCURRENCY) {
    const batch = pending.slice(i, i + CONCURRENCY);
    const results = await Promise.allSettled(
      batch.map((finding) => analyzeAndRankFinding(finding)),
    );

    for (let j = 0; j < results.length; j++) {
      if (results[j].status === "fulfilled") {
        analyzed++;
      } else {
        log.error({ err: (results[j] as PromiseRejectedResult).reason, findingId: batch[j].id }, "Error analyzing finding, continuing");
      }
    }
  }

  return analyzed;
}
