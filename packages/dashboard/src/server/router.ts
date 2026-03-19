import { z } from "zod";
import { eq, asc, desc, sql, inArray } from "drizzle-orm";
import { readFile, writeFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { existsSync } from "node:fs";
import { getDb, schema, getConfig, setRuntimeOverride, getRuntimeOverrides, createLogger, getSecurityHuntHistory } from "@algora/core";
import { analyzeAndRank } from "@algora/analyzer";
import { solveBounty, forceStopSolver, clearSolverStatus } from "@algora/solver";
import { pollAllProviders } from "@algora/discovery";
import { pollAllSecurityProviders, submitReport, prepareSubmission, backfillSecurityRewards } from "@algora/security-discovery";
import { analyzeProgram, analyzeAndRankFinding } from "@algora/security-analyzer";
import { huntProgram, solveSecurityFinding, forceStopSecuritySolver, pickBestFinding, pickBestProgram, readSecuritySolverStatus, readAdversarialReviewStatus, processAdversarialQueue, isSecuritySolving, cancelAdversarialReview } from "@algora/security-solver";
import { router, publicProcedure } from "./trpc";
import {
  analyzeAllState,
  resetAnalyzeAllState,
  autoSolveState,
  resetAutoSolveState,
  queueState,
  resetQueueRunState,
  securityAnalyzeState,
  resetSecurityAnalyzeState,
  type QueueItem,
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
  // Detects stale status when the process has died without cleanup
  solverStatus: publicProcedure.query(async () => {
    const statusPath = join(getDataDir(), "solver-status.json");
    if (!existsSync(statusPath)) {
      return { active: false as const };
    }
    try {
      const raw = await readFile(statusPath, "utf-8");
      const status = JSON.parse(raw);

      if (status.active) {
        // Check if the process is still alive
        let processAlive = false;
        if (status.pid) {
          try {
            process.kill(status.pid, 0); // signal 0 = existence check
            processAlive = true;
          } catch {
            // Process is dead
          }
        }

        // Check if lastActivity is stale (no update for > 5 minutes)
        const staleThresholdMs = 5 * 60 * 1000;
        const lastActive = status.lastActivity ? new Date(status.lastActivity).getTime() : 0;
        const isStale = lastActive > 0 && Date.now() - lastActive > staleThresholdMs;

        if (!processAlive || isStale) {
          // Auto-clear the stale status file
          await writeFile(statusPath, JSON.stringify({ active: false }, null, 2), "utf-8");
          log.warn(
            { pid: status.pid, lastActivity: status.lastActivity, processAlive, isStale },
            "Cleared stale solver status — process dead or inactive",
          );
          return { active: false as const, wasStale: true, staleBountyId: status.bountyId };
        }
      }

      return status;
    } catch {
      return { active: false as const };
    }
  }),

  // Live solver logs — tail of data/logs/{bountyId}.log
  solverLogs: publicProcedure
    .input(z.object({
      bountyId: z.string(),
      tailLines: z.number().min(1).max(500).default(80),
      maxChars: z.number().min(1000).max(500_000).default(100_000),
    }))
    .query(async ({ input }) => {
      const logPath = join(getDataDir(), "logs", `${input.bountyId}.log`);
      if (!existsSync(logPath)) {
        return { lines: [], totalSize: 0, raw: "", totalLength: 0 };
      }
      try {
        const content = await readFile(logPath, "utf-8");
        const allLines = content.split("\n");
        const lines = allLines.slice(-input.tailLines);
        const fileStat = await stat(logPath);
        const raw = content.slice(-input.maxChars);
        return { lines, totalSize: fileStat.size, raw, totalLength: content.length };
      } catch {
        return { lines: [], totalSize: 0, raw: "", totalLength: 0 };
      }
    }),

  // Structured stream-json events for rich terminal display
  solverEvents: publicProcedure
    .input(z.object({
      bountyId: z.string(),
      offset: z.number().min(0).default(0),
      maxEvents: z.number().min(1).max(500).default(200),
    }))
    .query(async ({ input }) => {
      const eventsPath = join(getDataDir(), "logs", `${input.bountyId}.jsonl`);
      if (!existsSync(eventsPath)) {
        return { events: [], totalEvents: 0, fileSize: 0 };
      }
      try {
        const content = await readFile(eventsPath, "utf-8");
        const lines = content.split("\n").filter((l) => l.trim());
        const totalEvents = lines.length;
        const sliced = lines.slice(input.offset, input.offset + input.maxEvents);
        const events = sliced.map((line) => {
          try { return JSON.parse(line); } catch { return null; }
        }).filter(Boolean);
        const fileStat = await stat(eventsPath);
        return { events, totalEvents, fileSize: fileStat.size };
      } catch {
        return { events: [], totalEvents: 0, fileSize: 0 };
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

  // Discover bounties on demand (all enabled providers)
  discoverNow: publicProcedure.mutation(async () => {
    await pollAllProviders();
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

          await solveBounty(updated, "auto");
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
          await solveBounty(updatedBounty, "manual");
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
  // ── Manual Queue endpoints ──────────────────────────────────

  // Get the current queue
  queue: publicProcedure.query(() => {
    return { ...queueState };
  }),

  // Add a bounty to the queue
  queueAdd: publicProcedure
    .input(z.string())
    .mutation(({ input }) => {
      if (queueState.items.some((i) => i.bountyId === input)) {
        return { success: false, reason: "already in queue" as const };
      }

      const db = getDb();
      const bounty = db.select().from(schema.bounties).where(eq(schema.bounties.id, input)).get();
      if (!bounty) {
        return { success: false, reason: "not found" as const };
      }

      queueState.items.push({
        bountyId: bounty.id,
        title: bounty.title,
        repoOwner: bounty.repoOwner,
        repoName: bounty.repoName,
        issueNumber: bounty.issueNumber,
        rewardCents: bounty.rewardCents,
        feasibilityScore: bounty.feasibilityScore,
        priorityScore: bounty.priorityScore,
        language: bounty.language,
      });

      return { success: true, reason: null };
    }),

  // Remove a bounty from the queue
  queueRemove: publicProcedure
    .input(z.string())
    .mutation(({ input }) => {
      const idx = queueState.items.findIndex((i) => i.bountyId === input);
      if (idx === -1) return { success: true, reason: null };
      // Can't remove the currently-solving or already-processed item
      if (queueState.running && idx <= queueState.currentIndex) {
        return { success: false, reason: "item already processed or solving" as const };
      }
      queueState.items.splice(idx, 1);
      return { success: true, reason: null };
    }),

  // Clear the entire queue
  queueClear: publicProcedure.mutation(() => {
    if (queueState.running) {
      return { success: false, reason: "queue is running" as const };
    }
    queueState.items = [];
    resetQueueRunState();
    return { success: true, reason: null };
  }),

  // Reorder queue items — accepts the full ordered list of bounty IDs
  queueReorder: publicProcedure
    .input(z.array(z.string()))
    .mutation(({ input }) => {
      if (queueState.running) {
        // While running, only allow reordering the not-yet-processed tail
        const frozenPrefix = queueState.items.slice(0, queueState.currentIndex + 1);
        const tail = queueState.items.slice(queueState.currentIndex + 1);
        const tailById = new Map(tail.map((i) => [i.bountyId, i]));
        const reorderedTail: QueueItem[] = [];
        for (const id of input) {
          const item = tailById.get(id);
          if (item) reorderedTail.push(item);
        }
        queueState.items = [...frozenPrefix, ...reorderedTail];
      } else {
        const byId = new Map(queueState.items.map((i) => [i.bountyId, i]));
        const reordered: QueueItem[] = [];
        for (const id of input) {
          const item = byId.get(id);
          if (item) reordered.push(item);
        }
        queueState.items = reordered;
      }
      return { success: true, reason: null };
    }),

  // Run the queue — solves each bounty in order
  queueRun: publicProcedure.mutation(() => {
    if (queueState.running) {
      return { started: false, reason: "already running" as const };
    }
    if (queueState.items.length === 0) {
      return { started: false, reason: "queue is empty" as const };
    }

    // Check solver not busy
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

    queueState.running = true;
    queueState.cancelled = false;
    queueState.currentIndex = 0;
    queueState.completed = 0;
    queueState.failed = 0;
    queueState.errors = [];
    queueState.startedAt = Date.now();

    (async () => {
      for (let i = 0; i < queueState.items.length; i++) {
        if (queueState.cancelled) break;

        queueState.currentIndex = i;
        const item = queueState.items[i];

        try {
          // Re-fetch bounty to get latest status
          const bounty = db
            .select()
            .from(schema.bounties)
            .where(eq(schema.bounties.id, item.bountyId))
            .get();

          if (!bounty) {
            queueState.errors.push({ bountyId: item.bountyId, error: "Bounty not found" });
            queueState.failed++;
            continue;
          }

          // Skip if already solved/merged/in non-solvable state
          if (!["discovered", "selected", "failed"].includes(bounty.status)) {
            log.info({ bountyId: bounty.id, status: bounty.status }, "Queue: skipping bounty (not solvable)");
            queueState.errors.push({ bountyId: item.bountyId, error: `Skipped: status is ${bounty.status}` });
            continue;
          }

          // Mark as attempting
          db.update(schema.bounties)
            .set({ status: "attempting", attemptedAt: new Date(), updatedAt: new Date() })
            .where(eq(schema.bounties.id, bounty.id))
            .run();

          const updatedBounty = db
            .select()
            .from(schema.bounties)
            .where(eq(schema.bounties.id, bounty.id))
            .get()!;

          await solveBounty(updatedBounty, "manual");
          queueState.completed++;
        } catch (err: any) {
          queueState.errors.push({
            bountyId: item.bountyId,
            error: err.message ?? String(err),
          });
          queueState.failed++;
          log.error({ err, bountyId: item.bountyId }, "Queue: solve error");

          // Clean up solver status on error
          try {
            await clearSolverStatus();
          } catch {}
        }
      }

      queueState.running = false;
      queueState.currentIndex = -1;
      log.info(
        { total: queueState.items.length, completed: queueState.completed, failed: queueState.failed },
        "Queue run completed",
      );
    })();

    return { started: true, reason: null };
  }),

  // Stop the running queue
  queueStop: publicProcedure.mutation(async () => {
    if (!queueState.running) {
      return { success: false, reason: "not running" as const };
    }

    queueState.cancelled = true;

    // Also stop the active solver
    try {
      await forceStopSolver();
    } catch {}

    queueState.running = false;
    queueState.currentIndex = -1;

    return { success: true, reason: null };
  }),

  // ── Security Bounty endpoints ──────────────────────────────

  // List security programs with optional status filter and sorting
  securityPrograms: publicProcedure
    .input(
      z
        .object({
          status: z.string().optional(),
          sortBy: z.enum(["rewardMaxCents", "name", "updatedAt"]).default("rewardMaxCents"),
          sortDir: z.enum(["asc", "desc"]).default("desc"),
          limit: z.number().min(1).max(500).default(250),
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

      return (query as any).limit(input?.limit ?? 250).offset(input?.offset ?? 0).all();
    }),

  // Get a single security program
  securityProgram: publicProcedure.input(z.string()).query(({ input }) => {
    const db = getDb();
    return db
      .select()
      .from(schema.securityPrograms)
      .where(eq(schema.securityPrograms.id, input))
      .get();
  }),

  // List security findings with optional filters
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
          // Joined program info
          programName: schema.securityPrograms.name,
          programProvider: schema.securityPrograms.provider,
          programLastHuntedAt: schema.securityPrograms.lastHuntedAt,
        })
        .from(schema.securityFindings)
        .leftJoin(schema.securityPrograms, eq(schema.securityFindings.programId, schema.securityPrograms.id))
        .orderBy(sortFn(sortCol));

      for (const cond of conditions) {
        query = query.where(cond) as any;
      }

      return (query as any).limit(input?.limit ?? 50).offset(input?.offset ?? 0).all();
    }),

  // Get a single security finding with program info
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
      })
      .from(schema.securityFindings)
      .leftJoin(schema.securityPrograms, eq(schema.securityFindings.programId, schema.securityPrograms.id))
      .where(eq(schema.securityFindings.id, input))
      .get();
  }),

  // Security dashboard stats
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

  // Discover security programs on demand
  securityDiscoverNow: publicProcedure.mutation(async () => {
    await pollAllSecurityProviders();
    return { success: true };
  }),

  // Accept a security finding — advance it forward in the pipeline
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

  // Reject a security finding — user explicitly rejects it
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

  // Undo a user rejection — reset back to discovered
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

  // Retry a failed security finding
  securityRetry: publicProcedure.input(z.string()).mutation(({ input }) => {
    const db = getDb();
    db.update(schema.securityFindings)
      .set({ status: "discovered", retryCount: 0, updatedAt: new Date() })
      .where(eq(schema.securityFindings.id, input))
      .run();
    return { success: true };
  }),

  // Approve a report — submit to HackerOne via API
  securityApproveReport: publicProcedure.input(z.string()).mutation(async ({ input }) => {
    const db = getDb();
    const finding = db.select().from(schema.securityFindings).where(eq(schema.securityFindings.id, input)).get();
    if (!finding) return { success: false, error: "Finding not found" };
    if (finding.status !== "reviewing" && finding.status !== "report_ready") return { success: false, error: `Finding is in "${finding.status}" status, expected "reviewing" (or "report_ready" to override)` };
    if (!finding.programId) return { success: false, error: "Finding has no associated program" };

    const program = db.select().from(schema.securityPrograms).where(eq(schema.securityPrograms.id, finding.programId)).get();
    if (!program) return { success: false, error: "Associated program not found" };

    const teamHandle = program.id.replace("h1-", "");

    try {
      // Use the submission agent to prepare a perfectly structured payload
      const scopeSummary = program.scopeSummary ? JSON.parse(program.scopeSummary) : {};
      const scopes = scopeSummary.scopes ?? [];
      const policy = scopeSummary.policy ?? undefined;

      const payload = await prepareSubmission({
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
      // Store the prepared submission for manual use on the dashboard
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

  // Delete a single security finding
  securityDeleteFinding: publicProcedure.input(z.string()).mutation(({ input }) => {
    const db = getDb();
    db.delete(schema.securityFindings)
      .where(eq(schema.securityFindings.id, input))
      .run();
    return { success: true };
  }),

  // Delete all security findings (bulk clear)
  securityDeleteAllFindings: publicProcedure.mutation(() => {
    const db = getDb();
    db.delete(schema.securityFindings).run();
    return { success: true };
  }),

  // Force-reset a stuck security finding
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

  // ── Security Analysis & Solve endpoints ─────────────────────

  // Batch-analyze all active security programs
  securityAnalyzePrograms: publicProcedure.mutation(() => {
    if (securityAnalyzeState.running) {
      // If state says running but no activity for >3 min, assume the loop crashed and force reset
      const lastActive = securityAnalyzeState.lastActivityAt ?? securityAnalyzeState.startedAt ?? 0;
      const idleMs = Date.now() - lastActive;
      if (idleMs < 3 * 60 * 1000) {
        return { started: false, reason: "already running" as const, total: 0 };
      }
      log.warn({ idleMs, completed: securityAnalyzeState.completed, total: securityAnalyzeState.total }, "Security analysis state appears stale, resetting");
    }

    const db = getDb();

    // Get programs that haven't been assessed yet
    const programs = db
      .select()
      .from(schema.securityPrograms)
      .where(eq(schema.securityPrograms.status, "active"))
      .orderBy(desc(schema.securityPrograms.rewardMaxCents))
      .all();

    // Filter to unassessed programs
    const unassessed = programs.filter((p) => {
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
        // Process programs in concurrent batches
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

  // Batch-analyze all discovered security findings
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

  // Poll security analysis progress
  securityAnalyzeStatus: publicProcedure.query(() => {
    return { ...securityAnalyzeState };
  }),

  // Stop the security analysis loop
  securityStopAnalyze: publicProcedure.mutation(() => {
    securityAnalyzeState.cancelled = true;
    securityAnalyzeState.running = false;

    // Reset currently-analyzing finding back to discovered
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

  // Re-assess all programs (clear assessments and re-analyze)
  securityReassessPrograms: publicProcedure.mutation(() => {
    if (securityAnalyzeState.running) {
      return { success: false, reason: "analysis running" as const };
    }

    const db = getDb();

    // Clear assessments from all programs by resetting scopeSummary to just scopes
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
          // Keep scopes, remove assessment
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

    // Also reset validated/failed findings back to discovered
    const resetFindings = db.update(schema.securityFindings)
      .set({ status: "discovered", confidenceScore: null, analysisNotes: null, updatedAt: new Date() })
      .where(sql`${schema.securityFindings.status} IN ('validated', 'analyzing', 'failed')`)
      .returning({ id: schema.securityFindings.id })
      .all();

    return { success: true, reason: null, programsCleared: cleared, findingsReset: resetFindings.length };
  }),

  // Enhanced security stats with assessment metrics
  securityDetailedStats: publicProcedure.query(() => {
    const db = getDb();

    const programs = db.select().from(schema.securityPrograms).all();
    const findings = db.select().from(schema.securityFindings).all();

    // Program assessment stats
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

    // Finding stats
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
      // Split report_ready into awaiting review vs already reviewed
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

    // Pipeline counts
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

  // ── Security Solver endpoints ───────────────────────────────

  // Hunt a specific program — launches Opus to find vulnerabilities in the program's scope
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

      // Fire-and-forget hunt, then auto-trigger adversarial review
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

  // Auto-hunt: pick the best assessed program and hunt it
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

  // Backfill reward data for programs missing it
  securityBackfillRewards: publicProcedure.mutation(async () => {
    const count = await backfillSecurityRewards();
    return { backfilled: count };
  }),

  // Toggle auto-hunt on/off
  securitySetAutoHunt: publicProcedure
    .input(z.object({ enabled: z.boolean() }))
    .mutation(({ input }) => {
      setRuntimeOverride("SECURITY_AUTO_HUNT_ENABLED", input.enabled);
      return { enabled: input.enabled };
    }),

  // Check if auto-hunt is enabled
  securityAutoHuntEnabled: publicProcedure.query(() => {
    const config = getConfig();
    return { enabled: config.SECURITY_AUTO_HUNT_ENABLED };
  }),

  // Solve a specific security finding by ID (launches Opus)
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

      // Fire-and-forget solve
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

  // Auto-solve: pick the best validated finding and solve it
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

  // Get security solver status
  securitySolverStatus: publicProcedure.query(async () => {
    return readSecuritySolverStatus();
  }),

  // Force-stop the security solver
  securityForceStopSolver: publicProcedure.mutation(async () => {
    const result = await forceStopSecuritySolver();
    return result;
  }),

  // Kill everything — stop solver, analysis, and adversarial review
  securityKillAll: publicProcedure.mutation(async () => {
    const solverResult = await forceStopSecuritySolver();

    // Stop analysis
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

    // Stop adversarial review
    const reviewCancelled = await cancelAdversarialReview();

    return {
      solverKilled: solverResult.killed,
      analysisStopped: true,
      reviewCancelled,
    };
  }),

  // Get security solver logs (tail N chars, raw for xterm rendering)
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

  // Recent hunt history
  securityHuntHistory: publicProcedure.query(async () => {
    const history = await getSecurityHuntHistory();
    return history.slice(0, 20);
  }),

  // Get hunt logs for a program (raw for xterm rendering)
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

  // Get adversarial review status
  securityAdversarialStatus: publicProcedure.query(async () => {
    return readAdversarialReviewStatus();
  }),

  // Reassess findings: clear adversarial reviews on unsubmitted/unrejected findings and re-run
  securityReassessFindings: publicProcedure.mutation(() => {
    if (securityAnalyzeState.running) {
      return { started: false, reason: "analysis running" as const, reset: 0 };
    }

    const db = getDb();

    // Find all findings that are unsubmitted and unrejected (report_ready or reviewing)
    const findings = db
      .select()
      .from(schema.securityFindings)
      .where(sql`${schema.securityFindings.status} IN ('report_ready', 'reviewing')`)
      .all();

    if (findings.length === 0) {
      return { started: false, reason: "no findings to reassess" as const, reset: 0 };
    }

    // Clear adversarial review from analysis notes and reset to report_ready
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

    // Trigger adversarial review
    (async () => {
      try {
        await processAdversarialQueue();
      } catch (err) {
        log.error({ err }, "Reassess findings adversarial review error");
      }
    })();

    return { started: true, reason: null, reset };
  }),

  // Manually trigger adversarial review on all report_ready findings
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
