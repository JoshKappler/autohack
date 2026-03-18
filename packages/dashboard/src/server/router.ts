import { z } from "zod";
import { eq, asc, desc, sql, inArray } from "drizzle-orm";
import { readFile, writeFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { existsSync } from "node:fs";
import { getDb, schema, getConfig, setRuntimeOverride, getRuntimeOverrides, createLogger } from "@algora/core";
import { analyzeAndRank } from "@algora/analyzer";
import { solveBounty, forceStopSolver, clearSolverStatus } from "@algora/solver";
import { pollAlgora } from "@algora/discovery";
import { router, publicProcedure } from "./trpc";
import {
  analyzeAllState,
  resetAnalyzeAllState,
  autoSolveState,
  resetAutoSolveState,
} from "./job-state";

const log = createLogger("dashboard-api");

function getDataDir(): string {
  return join(process.env.PROJECT_ROOT || process.cwd(), "data");
}

export const appRouter = router({
  // List all bounties with optional status filter and sorting
  bounties: publicProcedure
    .input(
      z
        .object({
          status: z.string().optional(),
          sortBy: z.enum(["priorityScore", "rewardCents", "feasibilityScore", "updatedAt", "discoveredAt"]).default("priorityScore"),
          sortDir: z.enum(["asc", "desc"]).default("desc"),
          limit: z.number().min(1).max(100).default(50),
          offset: z.number().min(0).default(0),
        })
        .optional(),
    )
    .query(({ input }) => {
      const db = getDb();
      const sortColumnMap: Record<string, any> = {
        priorityScore: schema.bounties.priorityScore,
        rewardCents: schema.bounties.rewardCents,
        feasibilityScore: schema.bounties.feasibilityScore,
        updatedAt: schema.bounties.updatedAt,
        discoveredAt: schema.bounties.discoveredAt,
      };
      const sortCol = sortColumnMap[input?.sortBy ?? "priorityScore"] ?? schema.bounties.priorityScore;
      const sortFn = (input?.sortDir ?? "desc") === "asc" ? asc : desc;
      let query = db.select().from(schema.bounties).orderBy(sortFn(sortCol));

      if (input?.status) {
        query = query.where(eq(schema.bounties.status, input.status as any)) as any;
      }

      return (query as any).limit(input?.limit ?? 50).offset(input?.offset ?? 0).all();
    }),

  // Get a single bounty
  bounty: publicProcedure.input(z.string()).query(({ input }) => {
    const db = getDb();
    return db
      .select()
      .from(schema.bounties)
      .where(eq(schema.bounties.id, input))
      .get();
  }),

  // Dashboard stats
  stats: publicProcedure.query(() => {
    const db = getDb();

    const total = db
      .select({ count: sql<number>`count(*)` })
      .from(schema.bounties)
      .get();

    const byStatus = db
      .select({
        status: schema.bounties.status,
        count: sql<number>`count(*)`,
      })
      .from(schema.bounties)
      .groupBy(schema.bounties.status)
      .all();

    const totalEarned = db
      .select({
        total: sql<number>`coalesce(sum(${schema.bounties.earnedCents}), 0)`,
      })
      .from(schema.bounties)
      .where(eq(schema.bounties.status, "merged"))
      .get();

    const activePipeline = db
      .select({ count: sql<number>`count(*)` })
      .from(schema.bounties)
      .where(
        sql`${schema.bounties.status} IN ('analyzing', 'selected', 'attempting', 'solving', 'pr_created', 'in_review')`,
      )
      .get();

    const analyzedCount = db
      .select({ count: sql<number>`count(*)` })
      .from(schema.bounties)
      .where(
        sql`${schema.bounties.status} NOT IN ('discovered')`,
      )
      .get();

    const analyzingCount = db
      .select({ count: sql<number>`count(*)` })
      .from(schema.bounties)
      .where(eq(schema.bounties.status, "analyzing"))
      .get();

    const solvingCount = db
      .select({ count: sql<number>`count(*)` })
      .from(schema.bounties)
      .where(sql`${schema.bounties.status} IN ('solving', 'attempting')`)
      .get();

    return {
      totalBounties: total?.count ?? 0,
      byStatus: Object.fromEntries(
        byStatus.map((r) => [r.status, r.count]),
      ),
      totalEarnedCents: totalEarned?.total ?? 0,
      activePipeline: activePipeline?.count ?? 0,
      analyzedCount: analyzedCount?.count ?? 0,
      pipelinePhase: (solvingCount?.count ?? 0) > 0 ? "solving" as const
        : (analyzingCount?.count ?? 0) > 0 ? "analyzing" as const
        : "idle" as const,
    };
  }),

  // Recent activity feed — last 20 bounty state changes
  activity: publicProcedure.query(() => {
    const db = getDb();
    return db
      .select()
      .from(schema.bounties)
      .orderBy(desc(schema.bounties.updatedAt))
      .limit(20)
      .all();
  }),

  // Pipeline runs (all or per bounty)
  pipelineRuns: publicProcedure
    .input(z.string().optional())
    .query(({ input }) => {
      const db = getDb();
      let query = db
        .select()
        .from(schema.pipelineRuns)
        .orderBy(desc(schema.pipelineRuns.startedAt));

      if (input) {
        query = query.where(eq(schema.pipelineRuns.bountyId, input)) as any;
      }

      return (query as any).limit(100).all();
    }),

  // Current system config (read-only view)
  config: publicProcedure.query(() => {
    const config = getConfig();
    const overrides = getRuntimeOverrides();
    return {
      claudeBackend: config.CLAUDE_BACKEND,
      claudeModel: config.CLAUDE_MODEL,
      analysisModel: config.ANALYSIS_MODEL,
      requireApproval: config.REQUIRE_APPROVAL,
      autoRespondReviews: config.AUTO_RESPOND_REVIEWS,
      autoFixReviews: config.AUTO_FIX_REVIEWS,
      maxReviewFixAttempts: config.MAX_REVIEW_FIX_ATTEMPTS,
      solveTimeoutMinutes: config.SOLVE_TIMEOUT_MINUTES,
      mode: config.REQUIRE_APPROVAL ? "review" as const : "auto" as const,
      hasOverrides: Object.keys(overrides).length > 0,
    };
  }),

  // Live solver status — reads from data/solver-status.json
  solverStatus: publicProcedure.query(async () => {
    const statusPath = join(getDataDir(), "solver-status.json");
    if (!existsSync(statusPath)) {
      return { active: false as const };
    }
    try {
      const raw = await readFile(statusPath, "utf-8");
      return JSON.parse(raw);
    } catch {
      return { active: false as const };
    }
  }),

  // Live solver logs — tail of data/logs/{bountyId}.log
  solverLogs: publicProcedure
    .input(z.object({
      bountyId: z.string(),
      tailLines: z.number().min(1).max(500).default(80),
    }))
    .query(async ({ input }) => {
      const logPath = join(getDataDir(), "logs", `${input.bountyId}.log`);
      if (!existsSync(logPath)) {
        return { lines: [], totalSize: 0 };
      }
      try {
        const content = await readFile(logPath, "utf-8");
        const allLines = content.split("\n");
        const lines = allLines.slice(-input.tailLines);
        const fileStat = await stat(logPath);
        return { lines, totalSize: fileStat.size };
      } catch {
        return { lines: [], totalSize: 0 };
      }
    }),

  // Toggle mode (auto vs review)
  setMode: publicProcedure
    .input(z.enum(["auto", "review"]))
    .mutation(({ input }) => {
      setRuntimeOverride("REQUIRE_APPROVAL", input === "review");
      return { success: true, mode: input };
    }),

  // Approve a bounty for solving
  approve: publicProcedure.input(z.string()).mutation(({ input }) => {
    const db = getDb();
    db.update(schema.bounties)
      .set({
        status: "attempting",
        attemptedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(schema.bounties.id, input))
      .run();
    return { success: true };
  }),

  // Retry a failed bounty
  retry: publicProcedure.input(z.string()).mutation(({ input }) => {
    const db = getDb();
    db.update(schema.bounties)
      .set({
        status: "discovered",
        retryCount: 0,
        updatedAt: new Date(),
      })
      .where(eq(schema.bounties.id, input))
      .run();
    return { success: true };
  }),

  // Dismiss a bounty
  dismiss: publicProcedure.input(z.string()).mutation(({ input }) => {
    const db = getDb();
    db.update(schema.bounties)
      .set({ status: "failed", updatedAt: new Date() })
      .where(eq(schema.bounties.id, input))
      .run();
    return { success: true };
  }),

  // Earnings over time
  earnings: publicProcedure.query(() => {
    const db = getDb();
    return db
      .select()
      .from(schema.bounties)
      .where(eq(schema.bounties.status, "merged"))
      .orderBy(desc(schema.bounties.updatedAt))
      .all();
  }),

  // ── Control Center endpoints ──────────────────────────────────

  // Discover bounties on demand
  discoverNow: publicProcedure.mutation(async () => {
    await pollAlgora();
    return { success: true };
  }),

  // Reset all assessed bounties back to discovered and clear memory
  reassessAll: publicProcedure.mutation(async () => {
    if (analyzeAllState.running) {
      return { success: false, reason: "analysis running" as const, reset: 0 };
    }

    const db = getDb();

    // Reset analyzed/selected/failed bounties back to discovered
    const resetStatuses = ["analyzing", "selected", "failed"] as const;
    const result = db.update(schema.bounties)
      .set({
        status: "discovered",
        feasibilityScore: null,
        estimatedHours: null,
        analysisNotes: null,
        priorityScore: null,
        retryCount: 0,
        updatedAt: new Date(),
      })
      .where(inArray(schema.bounties.status, [...resetStatuses]))
      .run();

    // Clear pipeline runs for reset bounties
    db.delete(schema.pipelineRuns)
      .where(sql`${schema.pipelineRuns.bountyId} IN (
        SELECT ${schema.bounties.id} FROM ${schema.bounties}
        WHERE ${schema.bounties.status} = 'discovered'
      )`)
      .run();

    // Reset memory.json
    const memoryPath = join(getDataDir(), "memory.json");
    const emptyMemory = { solveHistory: [], reviewFixes: [], failedRepos: {}, failedPatterns: [] };
    await writeFile(memoryPath, JSON.stringify(emptyMemory, null, 2), "utf-8");

    log.info({ reset: result.changes }, "Reassess: reset all assessments and memory");
    return { success: true, reason: null, reset: result.changes };
  }),

  // Analyze all discovered bounties sequentially
  analyzeAll: publicProcedure.mutation(() => {
    if (analyzeAllState.running) {
      return { started: false, reason: "already running" as const, total: analyzeAllState.total };
    }

    const db = getDb();
    const discovered = db
      .select()
      .from(schema.bounties)
      .where(eq(schema.bounties.status, "discovered"))
      .orderBy(asc(schema.bounties.rewardCents))
      .all();

    if (discovered.length === 0) {
      return { started: false, reason: "no bounties" as const, total: 0 };
    }

    // Reset and start
    resetAnalyzeAllState();
    analyzeAllState.running = true;
    analyzeAllState.total = discovered.length;
    analyzeAllState.startedAt = Date.now();

    // Fire-and-forget: run analysis loop in background
    (async () => {
      for (const bounty of discovered) {
        if (analyzeAllState.cancelled) break;

        analyzeAllState.currentBountyId = bounty.id;
        analyzeAllState.currentBountyTitle = bounty.title;

        try {
          await analyzeAndRank(bounty);
        } catch (err: any) {
          analyzeAllState.errors.push({
            bountyId: bounty.id,
            error: err.message ?? String(err),
          });
          log.error({ err, bountyId: bounty.id }, "Error analyzing bounty in batch");
        }

        analyzeAllState.completed++;
      }

      analyzeAllState.running = false;
      analyzeAllState.currentBountyId = null;
      analyzeAllState.currentBountyTitle = null;
      log.info(
        { total: analyzeAllState.total, completed: analyzeAllState.completed, errors: analyzeAllState.errors.length },
        "Analyze all completed",
      );
    })();

    return { started: true, reason: null, total: discovered.length };
  }),

  // Poll analyze-all progress
  analyzeAllStatus: publicProcedure.query(() => {
    return { ...analyzeAllState };
  }),

  // Stop the analyze-all loop and reset current bounty
  stopAnalyzeAll: publicProcedure.mutation(() => {
    analyzeAllState.cancelled = true;
    analyzeAllState.running = false;

    // Reset the currently-analyzing bounty back to discovered
    let resetBountyId: string | null = null;
    if (analyzeAllState.currentBountyId) {
      resetBountyId = analyzeAllState.currentBountyId;
      const db = getDb();
      db.update(schema.bounties)
        .set({ status: "discovered", updatedAt: new Date() })
        .where(eq(schema.bounties.id, analyzeAllState.currentBountyId))
        .run();
    }

    analyzeAllState.currentBountyId = null;
    analyzeAllState.currentBountyTitle = null;

    return { success: true, resetBountyId };
  }),

  // Auto-solve: solve the top-ranked selected bounty
  startAutoSolve: publicProcedure.mutation(() => {
    if (autoSolveState.running) {
      return { started: false, reason: "already running" as const };
    }

    // Check if solver is already busy
    const db = getDb();
    const activeSolve = db
      .select()
      .from(schema.bounties)
      .where(sql`${schema.bounties.status} IN ('solving', 'attempting')`)
      .limit(1)
      .get();

    if (activeSolve) {
      return { started: false, reason: "solver busy" as const };
    }

    resetAutoSolveState();
    autoSolveState.running = true;
    autoSolveState.startedAt = Date.now();

    (async () => {
      try {
        // Solve the top-ranked selected bounty
        autoSolveState.phase = "solving";
        const topBounty = db
          .select()
          .from(schema.bounties)
          .where(eq(schema.bounties.status, "selected"))
          .orderBy(desc(schema.bounties.priorityScore))
          .limit(1)
          .get();

        if (topBounty) {
          db.update(schema.bounties)
            .set({ status: "attempting", attemptedAt: new Date(), updatedAt: new Date() })
            .where(eq(schema.bounties.id, topBounty.id))
            .run();

          const updated = db
            .select()
            .from(schema.bounties)
            .where(eq(schema.bounties.id, topBounty.id))
            .get()!;

          await solveBounty(updated);
        }
      } catch (err) {
        log.error({ err }, "Auto-solve error");
        try {
          const { clearSolverStatus } = await import("@algora/solver");
          await clearSolverStatus();
        } catch {}
      } finally {
        resetAutoSolveState();
      }
    })();

    return { started: true, reason: null };
  }),

  // Solve a specific bounty by ID
  solveSpecificBounty: publicProcedure
    .input(z.string())
    .mutation(({ input }) => {
      const db = getDb();

      // Check solver not busy
      const activeSolve = db
        .select()
        .from(schema.bounties)
        .where(sql`${schema.bounties.status} IN ('solving', 'attempting')`)
        .limit(1)
        .get();

      if (activeSolve) {
        return { started: false, reason: "solver busy" as const };
      }

      const bounty = db
        .select()
        .from(schema.bounties)
        .where(eq(schema.bounties.id, input))
        .get();

      if (!bounty) {
        return { started: false, reason: "not found" as const };
      }

      if (!["selected", "discovered"].includes(bounty.status)) {
        return { started: false, reason: `invalid status: ${bounty.status}` as const };
      }

      // Mark as attempting
      db.update(schema.bounties)
        .set({ status: "attempting", attemptedAt: new Date(), updatedAt: new Date() })
        .where(eq(schema.bounties.id, input))
        .run();

      // Fire-and-forget solve
      const updatedBounty = db
        .select()
        .from(schema.bounties)
        .where(eq(schema.bounties.id, input))
        .get()!;

      (async () => {
        try {
          await solveBounty(updatedBounty);
        } catch (err) {
          log.error({ err, bountyId: input }, "Solve specific bounty error");
          // Ensure state is cleaned up if solveBounty didn't handle the error
          try {
            const { clearSolverStatus } = await import("@algora/solver");
            await clearSolverStatus();
          } catch {}
        }
      })();

      return { started: true, reason: null };
    }),

  // ── Force Stop / Reset endpoints ─────────────────────────────

  // Force-stop the active solver process and reset all stuck state
  forceStop: publicProcedure.mutation(async () => {
    log.warn("Force-stop requested from dashboard");

    // Stop any in-progress batch jobs
    analyzeAllState.cancelled = true;
    analyzeAllState.running = false;
    analyzeAllState.currentBountyId = null;
    analyzeAllState.currentBountyTitle = null;
    resetAutoSolveState();

    // Kill active solver process and reset DB state
    const result = await forceStopSolver();

    return {
      success: true,
      processKilled: result.killed,
      resetBountyId: result.resetBountyId,
    };
  }),

  // Emergency reset: clear ALL stuck state. Designed for post-crash recovery
  // when the system is completely frozen with no running processes.
  forceReset: publicProcedure.mutation(async () => {
    log.warn("Emergency force-reset requested from dashboard");

    const db = getDb();

    // 1. Reset in-memory state
    resetAnalyzeAllState();
    resetAutoSolveState();

    // 2. Kill any active process
    try {
      const { killActiveProcess } = await import("@algora/solver");
      killActiveProcess();
    } catch {}

    // 3. Also try to kill the PID from solver-status.json (handles post-restart ghost)
    try {
      const statusPath = join(getDataDir(), "solver-status.json");
      if (existsSync(statusPath)) {
        const raw = await readFile(statusPath, "utf-8");
        const status = JSON.parse(raw);
        if (status.pid) {
          try {
            process.kill(status.pid, "SIGTERM");
            log.info({ pid: status.pid }, "Killed ghost process from solver-status.json");
          } catch {
            // Process already dead — expected after restart
          }
        }
      }
    } catch {}

    // 4. Clear solver status file
    await clearSolverStatus();

    // 5. Reset ALL stuck bounties in transient states
    const stuckAnalyzing = db.update(schema.bounties)
      .set({ status: "discovered", updatedAt: new Date() })
      .where(eq(schema.bounties.status, "analyzing"))
      .returning({ id: schema.bounties.id })
      .all();

    const stuckSolving = db.update(schema.bounties)
      .set({ status: "selected", updatedAt: new Date() })
      .where(sql`${schema.bounties.status} IN ('solving', 'attempting')`)
      .returning({ id: schema.bounties.id })
      .all();

    // 6. Mark all running pipeline runs as failed
    const stuckRuns = db.update(schema.pipelineRuns)
      .set({
        status: "failed",
        completedAt: new Date(),
        errorCategory: "timeout",
        errorMessage: "Emergency reset by user from dashboard",
      })
      .where(eq(schema.pipelineRuns.status, "running" as any))
      .returning({ id: schema.pipelineRuns.id })
      .all();

    log.info(
      {
        analyzingReset: stuckAnalyzing.length,
        solvingReset: stuckSolving.length,
        runsReset: stuckRuns.length,
      },
      "Emergency reset complete",
    );

    return {
      success: true,
      analyzingReset: stuckAnalyzing.length,
      solvingReset: stuckSolving.length,
      runsReset: stuckRuns.length,
    };
  }),

  // Force-reset a specific bounty out of a stuck state
  forceResetBounty: publicProcedure
    .input(z.string())
    .mutation(async ({ input }) => {
      const db = getDb();
      const bounty = db.select().from(schema.bounties).where(eq(schema.bounties.id, input)).get();
      if (!bounty) return { success: false, reason: "not found" as const };

      const wasStatus = bounty.status;

      // If this bounty is the one being solved, kill the process
      try {
        const statusPath = join(getDataDir(), "solver-status.json");
        if (existsSync(statusPath)) {
          const raw = await readFile(statusPath, "utf-8");
          const status = JSON.parse(raw);
          if (status.bountyId === input && status.active) {
            const { killActiveProcess } = await import("@algora/solver");
            killActiveProcess();
            await clearSolverStatus();
          }
        }
      } catch {}

      // Reset to appropriate state
      const resetStatus = ["analyzing"].includes(bounty.status) ? "discovered" : "selected";
      db.update(schema.bounties)
        .set({ status: resetStatus, updatedAt: new Date() })
        .where(eq(schema.bounties.id, input))
        .run();

      // Mark any running pipeline runs for this bounty as failed
      db.update(schema.pipelineRuns)
        .set({
          status: "failed",
          completedAt: new Date(),
          errorCategory: "timeout",
          errorMessage: `Force-reset from ${wasStatus} by user`,
        })
        .where(
          sql`${schema.pipelineRuns.bountyId} = ${input} AND ${schema.pipelineRuns.status} = 'running'`,
        )
        .run();

      log.info({ bountyId: input, from: wasStatus, to: resetStatus }, "Force-reset bounty");
      return { success: true, reason: null, from: wasStatus, to: resetStatus };
    }),

  // ── Tracing endpoints ──────────────────────────────────────

  // List pipeline traces with optional filters
  traces: publicProcedure
    .input(
      z
        .object({
          bountyId: z.string().optional(),
          status: z.enum(["running", "success", "failed"]).optional(),
          errorCategory: z.string().optional(),
          limit: z.number().min(1).max(200).default(50),
        })
        .optional(),
    )
    .query(({ input }) => {
      const db = getDb();
      const conditions: any[] = [];

      if (input?.bountyId) {
        conditions.push(eq(schema.pipelineRuns.bountyId, input.bountyId));
      }
      if (input?.status) {
        conditions.push(eq(schema.pipelineRuns.status, input.status as any));
      }
      if (input?.errorCategory) {
        conditions.push(eq(schema.pipelineRuns.errorCategory, input.errorCategory));
      }

      let query = db
        .select({
          id: schema.pipelineRuns.id,
          traceId: schema.pipelineRuns.traceId,
          bountyId: schema.pipelineRuns.bountyId,
          stage: schema.pipelineRuns.stage,
          status: schema.pipelineRuns.status,
          errorCategory: schema.pipelineRuns.errorCategory,
          errorMessage: schema.pipelineRuns.errorMessage,
          logs: schema.pipelineRuns.logs,
          startedAt: schema.pipelineRuns.startedAt,
          completedAt: schema.pipelineRuns.completedAt,
          durationMs: schema.pipelineRuns.durationMs,
          // Join bounty info
          bountyTitle: schema.bounties.title,
          repoOwner: schema.bounties.repoOwner,
          repoName: schema.bounties.repoName,
          issueNumber: schema.bounties.issueNumber,
          rewardCents: schema.bounties.rewardCents,
        })
        .from(schema.pipelineRuns)
        .leftJoin(schema.bounties, eq(schema.pipelineRuns.bountyId, schema.bounties.id))
        .orderBy(desc(schema.pipelineRuns.startedAt));

      if (conditions.length > 0) {
        for (const cond of conditions) {
          query = query.where(cond) as any;
        }
      }

      return (query as any).limit(input?.limit ?? 50).all();
    }),

  // Error summary stats for traces dashboard
  traceStats: publicProcedure.query(() => {
    const db = getDb();

    const totalRuns = db
      .select({ count: sql<number>`count(*)` })
      .from(schema.pipelineRuns)
      .get();

    const failedRuns = db
      .select({ count: sql<number>`count(*)` })
      .from(schema.pipelineRuns)
      .where(eq(schema.pipelineRuns.status, "failed" as any))
      .get();

    const byErrorCategory = db
      .select({
        category: schema.pipelineRuns.errorCategory,
        count: sql<number>`count(*)`,
      })
      .from(schema.pipelineRuns)
      .where(sql`${schema.pipelineRuns.errorCategory} IS NOT NULL`)
      .groupBy(schema.pipelineRuns.errorCategory)
      .all();

    const avgDuration = db
      .select({
        avg: sql<number>`avg(${schema.pipelineRuns.durationMs})`,
      })
      .from(schema.pipelineRuns)
      .where(sql`${schema.pipelineRuns.durationMs} IS NOT NULL`)
      .get();

    return {
      totalRuns: totalRuns?.count ?? 0,
      failedRuns: failedRuns?.count ?? 0,
      failureRate:
        (totalRuns?.count ?? 0) > 0
          ? ((failedRuns?.count ?? 0) / (totalRuns?.count ?? 0)) * 100
          : 0,
      byErrorCategory: Object.fromEntries(
        byErrorCategory.map((r) => [r.category ?? "unknown", r.count]),
      ),
      avgDurationMs: avgDuration?.avg ?? 0,
    };
  }),
});

export type AppRouter = typeof appRouter;
