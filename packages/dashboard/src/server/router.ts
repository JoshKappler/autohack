import { z } from "zod";
import { eq, asc, desc, sql, inArray } from "drizzle-orm";
import { readFile, writeFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { existsSync } from "node:fs";
import { getDb, schema, getConfig, setRuntimeOverride, getRuntimeOverrides, createLogger, getSecurityHuntHistory } from "@bounty/core";
import { pollAllSecurityProviders, submitReport, prepareSubmission, backfillSecurityRewards, backfillSignalRequirements, fetchProgramScopes } from "@bounty/security-discovery";
import { analyzeProgram, analyzeAndRankFinding } from "@bounty/security-analyzer";
import { huntProgram, solveSecurityFinding, forceStopSecuritySolver, pickBestFinding, pickBestProgram, rankEligiblePrograms, readSecuritySolverStatus, readAdversarialReviewStatus, processAdversarialQueue, isSecuritySolving, cancelAdversarialReview } from "@bounty/security-solver";
import { router, publicProcedure } from "./trpc";
import {
  securityAnalyzeState,
  resetSecurityAnalyzeState,
} from "./job-state";

const log = createLogger("dashboard-api");

function getDataDir(): string {
  return join(process.env.PROJECT_ROOT || process.cwd(), "data");
}

export const appRouter = router({
  // ── Settings ─────────────────────────────────────────────────

  config: publicProcedure.query(() => {
    const config = getConfig();
    const overrides = getRuntimeOverrides();
    return {
      HACKERONE_ENABLED: config.HACKERONE_ENABLED,
      SECURITY_AUTO_HUNT_ENABLED: config.SECURITY_AUTO_HUNT_ENABLED,
      SECURITY_MAX_DAILY_HUNTS: config.SECURITY_MAX_DAILY_HUNTS,
      SECURITY_HUNT_TIMEOUT_MINUTES: config.SECURITY_HUNT_TIMEOUT_MINUTES,
      SECURITY_MIN_CONFIDENCE: config.SECURITY_MIN_CONFIDENCE,
      SECURITY_HUNT_COOLDOWN_HOURS: config.SECURITY_HUNT_COOLDOWN_HOURS,
      SECURITY_MIN_REWARD_CENTS: config.SECURITY_MIN_REWARD_CENTS,
      SKIP_WEB_ONLY_PROGRAMS: config.SKIP_WEB_ONLY_PROGRAMS,
      CLAUDE_MODEL: config.CLAUDE_MODEL,
      REVIEW_MODEL: config.REVIEW_MODEL,
      ANALYSIS_MODEL: config.ANALYSIS_MODEL,
      SUBMISSION_MODEL: config.SUBMISSION_MODEL,
      HUNT_EFFORT: config.HUNT_EFFORT,
      REVIEW_EFFORT: config.REVIEW_EFFORT,
      SUBMISSION_EFFORT: config.SUBMISSION_EFFORT,
      ANALYSIS_EFFORT: config.ANALYSIS_EFFORT,
      overrides,
    };
  }),

  setConfig: publicProcedure
    .input(z.object({ key: z.string(), value: z.any() }))
    .mutation(({ input }) => {
      setRuntimeOverride(input.key as any, input.value);
      return { success: true };
    }),

  // ── Security Programs ────────────────────────────────────────

  securityPrograms: publicProcedure
    .input(
      z
        .object({
          status: z.string().optional(),
          sortBy: z.enum(["rewardMaxCents", "name", "updatedAt"]).default("rewardMaxCents"),
          sortDir: z.enum(["asc", "desc"]).default("desc"),
          limit: z.number().min(1).max(2000).default(1000),
          offset: z.number().min(0).default(0),
        })
        .optional(),
    )
    .query(({ input }) => {
      const db = getDb();
      const sortColumnMap: Record<string, any> = {
        rewardMaxCents: schema.securityPrograms.rewardMaxCents,
        name: schema.securityPrograms.name,
        updatedAt: schema.securityPrograms.updatedAt,
      };
      const sortCol = sortColumnMap[input?.sortBy ?? "name"] ?? schema.securityPrograms.name;
      const sortFn = (input?.sortDir ?? "asc") === "desc" ? desc : asc;
      let query = db.select().from(schema.securityPrograms).orderBy(sortFn(sortCol));

      if (input?.status) {
        query = query.where(eq(schema.securityPrograms.status, input.status as any)) as any;
      }

      return (query as any).limit(input?.limit ?? 1000).offset(input?.offset ?? 0).all();
    }),

  securityProgram: publicProcedure.input(z.string()).query(({ input }) => {
    const db = getDb();
    return db
      .select()
      .from(schema.securityPrograms)
      .where(eq(schema.securityPrograms.id, input))
      .get();
  }),

  // ── Security Findings ────────────────────────────────────────

  securityFindings: publicProcedure
    .input(
      z
        .object({
          programId: z.string().optional(),
          status: z.string().optional(),
          statuses: z.array(z.string()).optional(),
          severity: z.string().optional(),
          sortBy: z.enum(["confidenceScore", "severity", "updatedAt", "discoveredAt"]).default("discoveredAt"),
          sortDir: z.enum(["asc", "desc"]).default("desc"),
          limit: z.number().min(1).max(100).default(50),
          offset: z.number().min(0).default(0),
        })
        .optional(),
    )
    .query(({ input }) => {
      const db = getDb();
      const sortColumnMap: Record<string, any> = {
        confidenceScore: schema.securityFindings.confidenceScore,
        severity: schema.securityFindings.severity,
        updatedAt: schema.securityFindings.updatedAt,
        discoveredAt: schema.securityFindings.discoveredAt,
      };
      const sortCol = sortColumnMap[input?.sortBy ?? "discoveredAt"] ?? schema.securityFindings.discoveredAt;
      const sortFn = (input?.sortDir ?? "desc") === "asc" ? asc : desc;

      const conditions: any[] = [];
      if (input?.programId) conditions.push(eq(schema.securityFindings.programId, input.programId));
      if (input?.statuses?.length) conditions.push(inArray(schema.securityFindings.status, input.statuses as any));
      else if (input?.status) conditions.push(eq(schema.securityFindings.status, input.status as any));
      if (input?.severity) conditions.push(eq(schema.securityFindings.severity, input.severity as any));

      let query = db
        .select({
          id: schema.securityFindings.id,
          programId: schema.securityFindings.programId,
          title: schema.securityFindings.title,
          description: schema.securityFindings.description,
          severity: schema.securityFindings.severity,
          vulnerabilityType: schema.securityFindings.vulnerabilityType,
          targetAsset: schema.securityFindings.targetAsset,
          status: schema.securityFindings.status,
          analysisNotes: schema.securityFindings.analysisNotes,
          confidenceScore: schema.securityFindings.confidenceScore,
          reportUrl: schema.securityFindings.reportUrl,
          reportId: schema.securityFindings.reportId,
          rewardedCents: schema.securityFindings.rewardedCents,
          reportBody: schema.securityFindings.reportBody,
          retryCount: schema.securityFindings.retryCount,
          discoveredAt: schema.securityFindings.discoveredAt,
          submittedAt: schema.securityFindings.submittedAt,
          updatedAt: schema.securityFindings.updatedAt,
          programName: schema.securityPrograms.name,
          programProvider: schema.securityPrograms.provider,
          programUrl: schema.securityPrograms.url,
          programHandle: schema.securityPrograms.providerProgramId,
          programLastHuntedAt: schema.securityPrograms.lastHuntedAt,
          programRequiresSignal: schema.securityPrograms.requiresSignal,
        })
        .from(schema.securityFindings)
        .leftJoin(schema.securityPrograms, eq(schema.securityFindings.programId, schema.securityPrograms.id))
        .orderBy(sortFn(sortCol));

      for (const cond of conditions) {
        query = query.where(cond) as any;
      }

      return (query as any).limit(input?.limit ?? 50).offset(input?.offset ?? 0).all();
    }),

  securityFinding: publicProcedure.input(z.string()).query(({ input }) => {
    const db = getDb();
    return db
      .select({
        id: schema.securityFindings.id,
        programId: schema.securityFindings.programId,
        title: schema.securityFindings.title,
        description: schema.securityFindings.description,
        severity: schema.securityFindings.severity,
        vulnerabilityType: schema.securityFindings.vulnerabilityType,
        targetAsset: schema.securityFindings.targetAsset,
        status: schema.securityFindings.status,
        analysisNotes: schema.securityFindings.analysisNotes,
        confidenceScore: schema.securityFindings.confidenceScore,
        reportBody: schema.securityFindings.reportBody,
        reportUrl: schema.securityFindings.reportUrl,
        reportId: schema.securityFindings.reportId,
        rewardedCents: schema.securityFindings.rewardedCents,
        retryCount: schema.securityFindings.retryCount,
        discoveredAt: schema.securityFindings.discoveredAt,
        submittedAt: schema.securityFindings.submittedAt,
        updatedAt: schema.securityFindings.updatedAt,
        programName: schema.securityPrograms.name,
        programProvider: schema.securityPrograms.provider,
        programUrl: schema.securityPrograms.url,
        programHandle: schema.securityPrograms.providerProgramId,
      })
      .from(schema.securityFindings)
      .leftJoin(schema.securityPrograms, eq(schema.securityFindings.programId, schema.securityPrograms.id))
      .where(eq(schema.securityFindings.id, input))
      .get();
  }),

  // ── Stats ────────────────────────────────────────────────────

  securityStats: publicProcedure.query(() => {
    const db = getDb();

    const totalPrograms = db
      .select({ count: sql<number>`count(*)` })
      .from(schema.securityPrograms)
      .get();

    const totalFindings = db
      .select({ count: sql<number>`count(*)` })
      .from(schema.securityFindings)
      .get();

    const byStatus = db
      .select({
        status: schema.securityFindings.status,
        count: sql<number>`count(*)`,
      })
      .from(schema.securityFindings)
      .groupBy(schema.securityFindings.status)
      .all();

    const bySeverity = db
      .select({
        severity: schema.securityFindings.severity,
        count: sql<number>`count(*)`,
      })
      .from(schema.securityFindings)
      .where(sql`${schema.securityFindings.severity} IS NOT NULL`)
      .groupBy(schema.securityFindings.severity)
      .all();

    const totalRewarded = db
      .select({
        total: sql<number>`coalesce(sum(${schema.securityFindings.rewardedCents}), 0)`,
      })
      .from(schema.securityFindings)
      .where(eq(schema.securityFindings.status, "rewarded"))
      .get();

    return {
      totalPrograms: totalPrograms?.count ?? 0,
      totalFindings: totalFindings?.count ?? 0,
      byStatus: Object.fromEntries(byStatus.map((r) => [r.status, r.count])),
      bySeverity: Object.fromEntries(bySeverity.map((r) => [r.severity ?? "unknown", r.count])),
      totalRewardedCents: totalRewarded?.total ?? 0,
    };
  }),

  securityDetailedStats: publicProcedure.query(() => {
    const db = getDb();

    const programs = db.select().from(schema.securityPrograms).all();
    const findings = db.select().from(schema.securityFindings).all();

    let assessedPrograms = 0;
    let totalOpportunityScore = 0;
    let avgOpportunityScore = 0;
    const rewardBuckets = { low: 0, medium: 0, high: 0, premium: 0 };

    for (const p of programs) {
      try {
        const parsed = JSON.parse(p.scopeSummary || "{}");
        if (parsed.assessment?.opportunityScore != null) {
          assessedPrograms++;
          totalOpportunityScore += parsed.assessment.opportunityScore;
        }
      } catch {}

      const maxReward = p.rewardMaxCents ?? 0;
      if (maxReward >= 1000000) rewardBuckets.premium++;
      else if (maxReward >= 100000) rewardBuckets.high++;
      else if (maxReward >= 10000) rewardBuckets.medium++;
      else rewardBuckets.low++;
    }

    if (assessedPrograms > 0) {
      avgOpportunityScore = totalOpportunityScore / assessedPrograms;
    }

    const byStatus: Record<string, number> = {};
    const bySeverity: Record<string, number> = {};
    let totalConfidence = 0;
    let confidenceCount = 0;
    let awaitingReview = 0;
    let reviewed = 0;

    for (const f of findings) {
      byStatus[f.status] = (byStatus[f.status] ?? 0) + 1;
      if (f.severity) bySeverity[f.severity] = (bySeverity[f.severity] ?? 0) + 1;
      if (f.confidenceScore != null) {
        totalConfidence += f.confidenceScore;
        confidenceCount++;
      }
      if (f.status === "report_ready") {
        let hasReview = false;
        try {
          const notes = JSON.parse(f.analysisNotes || "{}");
          hasReview = !!notes.adversarialReview;
        } catch {}
        if (hasReview) reviewed++;
        else awaitingReview++;
      }
    }

    const totalRewardedCents = findings
      .filter((f) => f.status === "rewarded" && f.rewardedCents)
      .reduce((sum, f) => sum + (f.rewardedCents ?? 0), 0);

    const pipelineStatuses = ["scanning", "analyzing", "validated", "drafting", "report_ready"];
    const activePipeline = findings.filter((f) => pipelineStatuses.includes(f.status)).length;

    return {
      totalPrograms: programs.length,
      activePrograms: programs.filter((p) => p.status === "active").length,
      assessedPrograms,
      avgOpportunityScore,
      rewardBuckets,
      totalFindings: findings.length,
      byStatus,
      bySeverity,
      avgConfidence: confidenceCount > 0 ? totalConfidence / confidenceCount : 0,
      totalRewardedCents,
      activePipeline,
      discoveredFindings: byStatus["discovered"] ?? 0,
      validatedFindings: byStatus["validated"] ?? 0,
      reportReadyFindings: byStatus["report_ready"] ?? 0,
      awaitingReview,
      reviewed,
    };
  }),

  // ── Discovery ────────────────────────────────────────────────

  securityDiscoverNow: publicProcedure.mutation(async () => {
    await pollAllSecurityProviders();
    return { success: true };
  }),

  // ── Finding Actions ──────────────────────────────────────────

  securityAccept: publicProcedure.input(z.string()).mutation(({ input }) => {
    const db = getDb();
    const finding = db.select().from(schema.securityFindings).where(eq(schema.securityFindings.id, input)).get();
    if (!finding) return { success: false, error: "Finding not found" };
    const terminal = ["submitted", "triaged", "accepted", "rewarded"];
    if (terminal.includes(finding.status)) return { success: false, error: `Cannot accept a "${finding.status}" finding` };
    const nextStatus = finding.reportBody ? "report_ready" : "validated";
    db.update(schema.securityFindings)
      .set({ status: nextStatus, updatedAt: new Date() })
      .where(eq(schema.securityFindings.id, input))
      .run();
    return { success: true };
  }),

  securityReject: publicProcedure.input(z.string()).mutation(({ input }) => {
    const db = getDb();
    const finding = db.select().from(schema.securityFindings).where(eq(schema.securityFindings.id, input)).get();
    if (!finding) return { success: false, error: "Finding not found" };
    const terminal = ["submitted", "triaged", "accepted", "rewarded"];
    if (terminal.includes(finding.status)) return { success: false, error: `Cannot reject a "${finding.status}" finding` };
    db.update(schema.securityFindings)
      .set({ status: "dismissed", updatedAt: new Date() })
      .where(eq(schema.securityFindings.id, input))
      .run();
    return { success: true };
  }),

  securityUndoReject: publicProcedure.input(z.string()).mutation(({ input }) => {
    const db = getDb();
    const finding = db.select().from(schema.securityFindings).where(eq(schema.securityFindings.id, input)).get();
    if (!finding) return { success: false, error: "Finding not found" };
    if (finding.status !== "dismissed") return { success: false, error: `Finding is in "${finding.status}" status, expected "dismissed"` };
    db.update(schema.securityFindings)
      .set({ status: "discovered", updatedAt: new Date() })
      .where(eq(schema.securityFindings.id, input))
      .run();
    return { success: true };
  }),

  securityRetry: publicProcedure.input(z.string()).mutation(({ input }) => {
    const db = getDb();
    db.update(schema.securityFindings)
      .set({ status: "discovered", retryCount: 0, updatedAt: new Date() })
      .where(eq(schema.securityFindings.id, input))
      .run();
    return { success: true };
  }),

  securityApproveReport: publicProcedure.input(z.string()).mutation(async ({ input }) => {
    const db = getDb();
    const finding = db.select().from(schema.securityFindings).where(eq(schema.securityFindings.id, input)).get();
    if (!finding) return { success: false, error: "Finding not found" };
    if (finding.status !== "reviewing" && finding.status !== "report_ready") return { success: false, error: `Finding is in "${finding.status}" status, expected "reviewing" (or "report_ready" to override)` };
    if (!finding.programId) return { success: false, error: "Finding has no associated program" };

    const program = db.select().from(schema.securityPrograms).where(eq(schema.securityPrograms.id, finding.programId)).get();
    if (!program) return { success: false, error: "Associated program not found" };

    if (program.provider !== "hackerone") {
      return { success: false, error: `Auto-submit is only supported for HackerOne programs. This is a ${program.provider} program — use "Copy Report" for manual submission.` };
    }

    const teamHandle = program.id.replace("h1-", "");

    let payload: any;
    try {
      const scopeSummary = program.scopeSummary ? JSON.parse(program.scopeSummary) : {};
      const policy = scopeSummary.policy ?? undefined;

      // Fetch fresh scopes with IDs from HackerOne API (stored scopes may lack IDs)
      let scopes = scopeSummary.scopes ?? [];
      try {
        const freshScopes = await fetchProgramScopes(teamHandle);
        if (freshScopes.length > 0) scopes = freshScopes;
      } catch (err) {
        log.warn({ err, teamHandle }, "Failed to fetch fresh scopes — using stored scopes");
      }

      payload = await prepareSubmission({
        teamHandle,
        finding: {
          title: finding.title,
          description: finding.description ?? undefined,
          reportBody: finding.reportBody ?? finding.description ?? "",
          severity: finding.severity ?? "medium",
          vulnerabilityType: finding.vulnerabilityType ?? undefined,
          targetAsset: finding.targetAsset ?? undefined,
        },
        scopes,
        policy,
      });

      const result = await submitReport({ teamHandle, payload });

      db.update(schema.securityFindings)
        .set({
          status: "submitted",
          reportId: result.reportId,
          reportUrl: result.reportUrl,
          submittedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(schema.securityFindings.id, input))
        .run();

      return { success: true, reportId: result.reportId, reportUrl: result.reportUrl };
    } catch (err: any) {
      try {
        const existingNotes = JSON.parse(finding.analysisNotes || "{}");
        db.update(schema.securityFindings)
          .set({
            analysisNotes: JSON.stringify({
              ...existingNotes,
              manualSubmission: payload,
              submissionError: err.message ?? String(err),
              submissionUrl: `https://hackerone.com/${teamHandle}/reports/new`,
            }),
            updatedAt: new Date(),
          })
          .where(eq(schema.securityFindings.id, input))
          .run();
      } catch {}
      return { success: false, error: err.message ?? String(err) };
    }
  }),

  securityDeleteFinding: publicProcedure.input(z.string()).mutation(({ input }) => {
    const db = getDb();
    db.delete(schema.securityFindings)
      .where(eq(schema.securityFindings.id, input))
      .run();
    return { success: true };
  }),

  securityDeleteAllFindings: publicProcedure.mutation(() => {
    const db = getDb();
    db.delete(schema.securityFindings).run();
    return { success: true };
  }),

  securityForceResetFinding: publicProcedure.input(z.string()).mutation(({ input }) => {
    const db = getDb();
    const finding = db.select().from(schema.securityFindings).where(eq(schema.securityFindings.id, input)).get();
    if (!finding) return { success: false, reason: "not found" as const };

    const wasStatus = finding.status;
    db.update(schema.securityFindings)
      .set({ status: "discovered", updatedAt: new Date() })
      .where(eq(schema.securityFindings.id, input))
      .run();

    return { success: true, reason: null, from: wasStatus, to: "discovered" as const };
  }),

  // ── Analysis ─────────────────────────────────────────────────

  securityAnalyzePrograms: publicProcedure
    .input(z.object({ skipSignalRequired: z.boolean().optional() }).optional())
    .mutation(({ input }) => {
    if (securityAnalyzeState.running) {
      const lastActive = securityAnalyzeState.lastActivityAt ?? securityAnalyzeState.startedAt ?? 0;
      const idleMs = Date.now() - lastActive;
      if (idleMs < 3 * 60 * 1000) {
        return { started: false, reason: "already running" as const, total: 0 };
      }
      log.warn({ idleMs, completed: securityAnalyzeState.completed, total: securityAnalyzeState.total }, "Security analysis state appears stale, resetting");
    }

    const skipSignal = input?.skipSignalRequired ?? false;
    const db = getDb();

    const programs = db
      .select()
      .from(schema.securityPrograms)
      .where(eq(schema.securityPrograms.status, "active"))
      .orderBy(desc(schema.securityPrograms.rewardMaxCents))
      .all();

    const unassessed = programs.filter((p) => {
      if (skipSignal && p.requiresSignal) return false;
      try {
        const parsed = JSON.parse(p.scopeSummary || "{}");
        return !parsed.assessment?.opportunityScore;
      } catch {
        return true;
      }
    });

    if (unassessed.length === 0) {
      return { started: false, reason: "nothing to analyze" as const, total: 0 };
    }

    resetSecurityAnalyzeState();
    securityAnalyzeState.running = true;
    securityAnalyzeState.mode = "programs";
    securityAnalyzeState.total = unassessed.length;
    securityAnalyzeState.startedAt = Date.now();

    const CONCURRENCY = 5;

    (async () => {
      try {
        for (let i = 0; i < unassessed.length; i += CONCURRENCY) {
          if (securityAnalyzeState.cancelled) break;

          const batch = unassessed.slice(i, i + CONCURRENCY);
          securityAnalyzeState.currentName = batch.map((p) => p.name).join(", ");
          securityAnalyzeState.currentId = batch[0].id;

          const results = await Promise.allSettled(
            batch.map((program) => analyzeProgram(program)),
          );

          for (let j = 0; j < results.length; j++) {
            const result = results[j];
            if (result.status === "rejected") {
              securityAnalyzeState.errors.push({
                id: batch[j].id,
                error: result.reason?.message ?? String(result.reason),
              });
            }
            securityAnalyzeState.completed++;
          }
          securityAnalyzeState.lastActivityAt = Date.now();
        }
      } catch (err: any) {
        log.error({ err }, "Security program analysis loop crashed");
        securityAnalyzeState.errors.push({
          id: "loop",
          error: `Loop crashed: ${err.message ?? String(err)}`,
        });
      } finally {
        securityAnalyzeState.running = false;
        securityAnalyzeState.currentId = null;
        securityAnalyzeState.currentName = null;
        log.info(
          { total: securityAnalyzeState.total, completed: securityAnalyzeState.completed, errors: securityAnalyzeState.errors.length },
          "Security program analysis completed",
        );
      }
    })();

    return { started: true, reason: null, total: unassessed.length };
  }),

  securityAnalyzeFindings: publicProcedure.mutation(() => {
    if (securityAnalyzeState.running) {
      const lastActive = securityAnalyzeState.lastActivityAt ?? securityAnalyzeState.startedAt ?? 0;
      const idleMs = Date.now() - lastActive;
      if (idleMs < 3 * 60 * 1000) {
        return { started: false, reason: "already running" as const, total: 0 };
      }
      log.warn({ idleMs, completed: securityAnalyzeState.completed, total: securityAnalyzeState.total }, "Security findings analysis state appears stale, resetting");
    }

    const db = getDb();
    const discovered = db
      .select()
      .from(schema.securityFindings)
      .where(eq(schema.securityFindings.status, "discovered"))
      .all();

    if (discovered.length === 0) {
      return { started: false, reason: "nothing to analyze" as const, total: 0 };
    }

    resetSecurityAnalyzeState();
    securityAnalyzeState.running = true;
    securityAnalyzeState.mode = "findings";
    securityAnalyzeState.total = discovered.length;
    securityAnalyzeState.startedAt = Date.now();

    const CONCURRENCY = 5;

    (async () => {
      try {
        for (let i = 0; i < discovered.length; i += CONCURRENCY) {
          if (securityAnalyzeState.cancelled) break;

          const batch = discovered.slice(i, i + CONCURRENCY);
          securityAnalyzeState.currentName = batch.map((f) => f.title).join(", ");
          securityAnalyzeState.currentId = batch[0].id;

          const results = await Promise.allSettled(
            batch.map((finding) => analyzeAndRankFinding(finding)),
          );

          for (let j = 0; j < results.length; j++) {
            const result = results[j];
            if (result.status === "rejected") {
              securityAnalyzeState.errors.push({
                id: batch[j].id,
                error: result.reason?.message ?? String(result.reason),
              });
            }
            securityAnalyzeState.completed++;
          }
          securityAnalyzeState.lastActivityAt = Date.now();
        }
      } catch (err: any) {
        log.error({ err }, "Security finding analysis loop crashed");
        securityAnalyzeState.errors.push({
          id: "loop",
          error: `Loop crashed: ${err.message ?? String(err)}`,
        });
      } finally {
        securityAnalyzeState.running = false;
        securityAnalyzeState.currentId = null;
        securityAnalyzeState.currentName = null;
        log.info(
          { total: securityAnalyzeState.total, completed: securityAnalyzeState.completed, errors: securityAnalyzeState.errors.length },
          "Security finding analysis completed",
        );
      }
    })();

    return { started: true, reason: null, total: discovered.length };
  }),

  securityAnalyzeStatus: publicProcedure.query(() => {
    return { ...securityAnalyzeState };
  }),

  securityStopAnalyze: publicProcedure.mutation(() => {
    securityAnalyzeState.cancelled = true;
    securityAnalyzeState.running = false;

    if (securityAnalyzeState.currentId && securityAnalyzeState.mode === "findings") {
      const db = getDb();
      db.update(schema.securityFindings)
        .set({ status: "discovered", updatedAt: new Date() })
        .where(eq(schema.securityFindings.id, securityAnalyzeState.currentId))
        .run();
    }

    securityAnalyzeState.currentId = null;
    securityAnalyzeState.currentName = null;

    return { success: true };
  }),

  securityReassessPrograms: publicProcedure.mutation(() => {
    if (securityAnalyzeState.running) {
      return { success: false, reason: "analysis running" as const };
    }

    const db = getDb();

    const programs = db
      .select()
      .from(schema.securityPrograms)
      .where(eq(schema.securityPrograms.status, "active"))
      .all();

    let cleared = 0;
    for (const program of programs) {
      try {
        const parsed = JSON.parse(program.scopeSummary || "{}");
        if (parsed.assessment) {
          const scopes = parsed.scopes ?? parsed;
          db.update(schema.securityPrograms)
            .set({
              scopeSummary: JSON.stringify(Array.isArray(scopes) ? scopes : []),
              updatedAt: new Date(),
            })
            .where(eq(schema.securityPrograms.id, program.id))
            .run();
          cleared++;
        }
      } catch {}
    }

    const resetFindings = db.update(schema.securityFindings)
      .set({ status: "discovered", confidenceScore: null, analysisNotes: null, updatedAt: new Date() })
      .where(sql`${schema.securityFindings.status} IN ('validated', 'analyzing', 'failed')`)
      .returning({ id: schema.securityFindings.id })
      .all();

    return { success: true, reason: null, programsCleared: cleared, findingsReset: resetFindings.length };
  }),

  // ── Solver ───────────────────────────────────────────────────

  securityHuntProgram: publicProcedure
    .input(z.string())
    .mutation(({ input }) => {
      const db = getDb();

      const program = db
        .select()
        .from(schema.securityPrograms)
        .where(eq(schema.securityPrograms.id, input))
        .get();

      if (!program) {
        return { started: false, reason: "not found" as const };
      }

      if (program.status !== "active") {
        return { started: false, reason: `program is ${program.status}` as const };
      }

      if (isSecuritySolving()) {
        return { started: false, reason: "solver busy" as const };
      }

      (async () => {
        try {
          const result = await huntProgram(program, "manual");
          if (result.findingsCreated > 0) {
            log.info({ findingsCreated: result.findingsCreated }, "Hunt complete — auto-triggering adversarial review");
            await processAdversarialQueue(program.id);
          }
        } catch (err) {
          log.error({ err, programId: input }, "Security hunt error");
          try {
            await forceStopSecuritySolver();
          } catch {}
        }
      })();

      return { started: true, reason: null };
    }),

  securityAutoHunt: publicProcedure.mutation(() => {
    const best = pickBestProgram();
    if (!best) {
      return { started: false, reason: "no assessed programs" as const };
    }

    (async () => {
      try {
        const result = await huntProgram(best, "auto");
        if (result.findingsCreated > 0) {
          log.info({ findingsCreated: result.findingsCreated }, "Auto-hunt complete — auto-triggering adversarial review");
          await processAdversarialQueue(best.id);
        }
      } catch (err) {
        log.error({ err, programId: best.id }, "Security auto-hunt error");
        try {
          await forceStopSecuritySolver();
        } catch {}
      }
    })();

    return { started: true, reason: null, programId: best.id, programName: best.name };
  }),

  securityBackfillRewards: publicProcedure.mutation(async () => {
    const count = await backfillSecurityRewards();
    return { backfilled: count };
  }),

  securityBackfillSignal: publicProcedure.mutation(async () => {
    const count = await backfillSignalRequirements();
    return { backfilled: count };
  }),

  securityHuntQueue: publicProcedure.query(() => {
    const ranked = rankEligiblePrograms();
    return ranked.map((r, i) => ({
      rank: i + 1,
      id: r.program.id,
      name: r.program.name,
      score: Math.round(r.score * 100) / 100,
      rewardMaxCents: r.program.rewardMaxCents,
      lastHuntedAt: r.program.lastHuntedAt?.toISOString() ?? null,
      huntCount: r.program.huntCount ?? 0,
      huntMissStreak: r.program.huntMissStreak ?? 0,
    }));
  }),

  securitySetAutoHunt: publicProcedure
    .input(z.object({ enabled: z.boolean() }))
    .mutation(({ input }) => {
      setRuntimeOverride("SECURITY_AUTO_HUNT_ENABLED", input.enabled);
      return { enabled: input.enabled };
    }),

  securityAutoHuntEnabled: publicProcedure.query(() => {
    const config = getConfig();
    return { enabled: config.SECURITY_AUTO_HUNT_ENABLED };
  }),

  securitySetSkipSignal: publicProcedure
    .input(z.object({ enabled: z.boolean() }))
    .mutation(({ input }) => {
      setRuntimeOverride("SKIP_SIGNAL_REQUIRED", input.enabled);
      return input.enabled;
    }),

  securitySkipSignalRequired: publicProcedure.query(() => {
    const config = getConfig();
    return config.SKIP_SIGNAL_REQUIRED;
  }),

  securitySetSkipWebOnly: publicProcedure
    .input(z.object({ enabled: z.boolean() }))
    .mutation(({ input }) => {
      setRuntimeOverride("SKIP_WEB_ONLY_PROGRAMS", input.enabled);
      return input.enabled;
    }),

  securitySkipWebOnly: publicProcedure.query(() => {
    const config = getConfig();
    return config.SKIP_WEB_ONLY_PROGRAMS;
  }),

  securitySetSkipPreviouslyHunted: publicProcedure
    .input(z.object({ enabled: z.boolean() }))
    .mutation(({ input }) => {
      setRuntimeOverride("SKIP_PREVIOUSLY_HUNTED", input.enabled);
      return input.enabled;
    }),

  securitySkipPreviouslyHunted: publicProcedure.query(() => {
    const config = getConfig();
    return config.SKIP_PREVIOUSLY_HUNTED;
  }),

  securitySolveFinding: publicProcedure
    .input(z.string())
    .mutation(({ input }) => {
      const db = getDb();

      const finding = db
        .select()
        .from(schema.securityFindings)
        .where(eq(schema.securityFindings.id, input))
        .get();

      if (!finding) {
        return { started: false, reason: "not found" as const };
      }

      if (!["validated", "discovered"].includes(finding.status)) {
        return { started: false, reason: `invalid status: ${finding.status}` as const };
      }

      (async () => {
        try {
          await solveSecurityFinding(finding, "manual");
        } catch (err) {
          log.error({ err, findingId: input }, "Security solve error");
          try {
            await forceStopSecuritySolver();
          } catch {}
        }
      })();

      return { started: true, reason: null };
    }),

  securityAutoSolve: publicProcedure.mutation(() => {
    const best = pickBestFinding();
    if (!best) {
      return { started: false, reason: "no validated findings" as const };
    }

    (async () => {
      try {
        await solveSecurityFinding(best, "auto");
      } catch (err) {
        log.error({ err, findingId: best.id }, "Security auto-solve error");
        try {
          await forceStopSecuritySolver();
        } catch {}
      }
    })();

    return { started: true, reason: null, findingId: best.id, findingTitle: best.title };
  }),

  securitySolverStatus: publicProcedure.query(async () => {
    return readSecuritySolverStatus();
  }),

  securityForceStopSolver: publicProcedure.mutation(async () => {
    const result = await forceStopSecuritySolver();
    return result;
  }),

  securityKillAll: publicProcedure.mutation(async () => {
    const solverResult = await forceStopSecuritySolver();

    securityAnalyzeState.cancelled = true;
    securityAnalyzeState.running = false;
    if (securityAnalyzeState.currentId && securityAnalyzeState.mode === "findings") {
      const db = getDb();
      db.update(schema.securityFindings)
        .set({ status: "discovered", updatedAt: new Date() })
        .where(eq(schema.securityFindings.id, securityAnalyzeState.currentId))
        .run();
    }
    securityAnalyzeState.currentId = null;
    securityAnalyzeState.currentName = null;

    const reviewCancelled = await cancelAdversarialReview();

    return {
      solverKilled: solverResult.killed,
      analysisStopped: true,
      reviewCancelled,
    };
  }),

  // ── Logs ─────────────────────────────────────────────────────

  securitySolverLogs: publicProcedure
    .input(z.object({
      findingId: z.string(),
      tail: z.number().min(1).max(500).default(80),
      maxChars: z.number().min(1000).max(500_000).default(100_000),
    }))
    .query(async ({ input }) => {
      const logPath = join(getDataDir(), "logs", `sec-${input.findingId}.log`);
      if (!existsSync(logPath)) return { lines: [], raw: "", totalLength: 0 };
      try {
        const content = await readFile(logPath, "utf-8");
        const allLines = content.split("\n");
        const raw = content.slice(-input.maxChars);
        return { lines: allLines.slice(-input.tail), raw, totalLength: content.length };
      } catch {
        return { lines: [], raw: "", totalLength: 0 };
      }
    }),

  securityHuntEvents: publicProcedure
    .input(z.object({
      programId: z.string(),
      afterLine: z.number().min(0).default(0),
    }))
    .query(async ({ input }) => {
      const eventsPath = join(getDataDir(), "logs", `hunt-${input.programId}.log.events.jsonl`);
      if (!existsSync(eventsPath)) return { events: [], totalLines: 0 };
      try {
        const content = await readFile(eventsPath, "utf-8");
        const allLines = content.split("\n").filter((l) => l.trim());
        const newLines = allLines.slice(input.afterLine);
        const events = newLines.map((line) => {
          try { return JSON.parse(line); } catch { return null; }
        }).filter(Boolean);
        return { events, totalLines: allLines.length };
      } catch {
        return { events: [], totalLines: 0 };
      }
    }),

  securitySolverEvents: publicProcedure
    .input(z.object({
      findingId: z.string(),
      afterLine: z.number().min(0).default(0),
    }))
    .query(async ({ input }) => {
      const eventsPath = join(getDataDir(), "logs", `sec-${input.findingId}.log.events.jsonl`);
      if (!existsSync(eventsPath)) return { events: [], totalLines: 0 };
      try {
        const content = await readFile(eventsPath, "utf-8");
        const allLines = content.split("\n").filter((l) => l.trim());
        const newLines = allLines.slice(input.afterLine);
        const events = newLines.map((line) => {
          try { return JSON.parse(line); } catch { return null; }
        }).filter(Boolean);
        return { events, totalLines: allLines.length };
      } catch {
        return { events: [], totalLines: 0 };
      }
    }),

  securityHuntHistory: publicProcedure.query(async () => {
    const history = await getSecurityHuntHistory();
    return history.slice(0, 20);
  }),

  securityHuntLogs: publicProcedure
    .input(z.object({
      programId: z.string(),
      tail: z.number().min(1).max(500).default(80),
      maxChars: z.number().min(1000).max(500_000).default(100_000),
    }))
    .query(async ({ input }) => {
      const logPath = join(getDataDir(), "logs", `hunt-${input.programId}.log`);
      if (!existsSync(logPath)) return { lines: [], raw: "", totalLength: 0 };
      try {
        const content = await readFile(logPath, "utf-8");
        const allLines = content.split("\n");
        const raw = content.slice(-input.maxChars);
        return { lines: allLines.slice(-input.tail), raw, totalLength: content.length };
      } catch {
        return { lines: [], raw: "", totalLength: 0 };
      }
    }),

  securityAdversarialStatus: publicProcedure.query(async () => {
    return readAdversarialReviewStatus();
  }),

  securityReassessFindings: publicProcedure
    .input(z.object({ excludeSignalBlocked: z.boolean().default(false) }).optional())
    .mutation(({ input }) => {
    if (securityAnalyzeState.running) {
      return { started: false, reason: "analysis running" as const, reset: 0 };
    }

    const db = getDb();

    let findings = db
      .select()
      .from(schema.securityFindings)
      .where(sql`${schema.securityFindings.status} IN ('report_ready', 'reviewing')`)
      .all();

    // Filter out signal-blocked findings if requested
    if (input?.excludeSignalBlocked) {
      findings = findings.filter((f) => {
        try {
          const notes = JSON.parse(f.analysisNotes || "{}");
          return !notes.submissionError;
        } catch {
          return true;
        }
      });
    }

    if (findings.length === 0) {
      return { started: false, reason: "no findings to reassess" as const, reset: 0 };
    }

    let reset = 0;
    for (const finding of findings) {
      try {
        const notes = JSON.parse(finding.analysisNotes || "{}");
        delete notes.adversarialReview;
        db.update(schema.securityFindings)
          .set({
            status: "report_ready",
            analysisNotes: JSON.stringify(notes),
            updatedAt: new Date(),
          })
          .where(eq(schema.securityFindings.id, finding.id))
          .run();
        reset++;
      } catch {}
    }

    (async () => {
      try {
        await processAdversarialQueue();
      } catch (err) {
        log.error({ err }, "Reassess findings adversarial review error");
      }
    })();

    return { started: true, reason: null, reset };
  }),

  securityRunAdversarialReview: publicProcedure.mutation(() => {
    (async () => {
      try {
        await processAdversarialQueue();
      } catch (err) {
        log.error({ err }, "Manual adversarial review error");
      }
    })();
    return { started: true };
  }),
});

export type AppRouter = typeof appRouter;
