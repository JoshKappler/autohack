import "dotenv/config";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

// Set PROJECT_ROOT so all packages resolve paths correctly
const __filename = fileURLToPath(import.meta.url);
process.env.PROJECT_ROOT = dirname(__filename);

import { execFile } from "node:child_process";
import cron from "node-cron";
import { eq, and, gte, lt, sql } from "drizzle-orm";
import { loadConfig, getConfig, getDb, schema, createLogger } from "@algora/core";
import { pollAlgora, pollGitHub, pollAllProviders } from "@algora/discovery";
import { processAnalysisQueue } from "@algora/analyzer";
import { processNextBounty, readSolverStatus, clearSolverStatus } from "@algora/solver";
import { monitorReviews } from "@algora/monitor";
import { pollHackerOne, pollSubmissionStatuses } from "@algora/security-discovery";
import { processSecurityProgramQueue } from "@algora/security-analyzer";
import {
  huntProgram,
  pickBestProgram,
  readSecuritySolverStatus,
  clearSecuritySolverStatus as clearSecurityStatus,
  clearAdversarialReviewStatus,
  forceStopSecuritySolver,
  processAdversarialQueue,
} from "@algora/security-solver";

const log = createLogger("orchestrator");

// Max total attempts before a bounty is permanently skipped
const MAX_TOTAL_ATTEMPTS = 3;

function startDashboard(port: number) {
  const child = execFile("npx", ["next", "dev", "--port", String(port)], {
    cwd: new URL("./packages/dashboard", import.meta.url).pathname,
    env: { ...process.env },
  });
  child.stdout?.on("data", (d: Buffer) => process.stdout.write(d));
  child.stderr?.on("data", (d: Buffer) => process.stderr.write(d));
  child.on("error", (err) => log.error({ err }, "Dashboard failed to start"));
  log.info({ port }, "Dashboard starting");
  return child;
}

function resetStuckBounties() {
  const db = getDb();

  // Only permanently skip bounties that have exceeded max attempts.
  // The retry count condition MUST be in the SQL WHERE clause — filtering
  // after .all() would still update all failed bounties in the database.
  const overLimit = db
    .update(schema.bounties)
    .set({ status: "failed", updatedAt: new Date() })
    .where(
      and(
        eq(schema.bounties.status, "failed"),
        gte(schema.bounties.retryCount, MAX_TOTAL_ATTEMPTS),
      ),
    )
    .returning({ id: schema.bounties.id, retryCount: schema.bounties.retryCount })
    .all();

  if (overLimit.length > 0) {
    log.info({ count: overLimit.length }, "Permanently failed bounties that exceeded max attempts");
  }

  // Dismiss bounties below minimum reward threshold
  const config = loadConfig();
  const lowBounties = db
    .update(schema.bounties)
    .set({ status: "failed", updatedAt: new Date() })
    .where(
      and(
        sql`${schema.bounties.rewardCents} < ${config.MIN_BOUNTY_CENTS}`,
        sql`${schema.bounties.status} NOT IN ('failed', 'merged', 'rejected')`,
      ),
    )
    .returning({ id: schema.bounties.id, rewardCents: schema.bounties.rewardCents })
    .all();

  if (lowBounties.length > 0) {
    log.info({ count: lowBounties.length }, "Dismissed bounties below minimum reward");
  }

  // Reset bounties stuck in transient states from a previous shutdown
  const stuckAnalyzing = db
    .update(schema.bounties)
    .set({ status: "discovered", updatedAt: new Date() })
    .where(eq(schema.bounties.status, "analyzing"))
    .returning({ id: schema.bounties.id })
    .all();

  if (stuckAnalyzing.length > 0) {
    log.info({ count: stuckAnalyzing.length }, "Reset stuck analyzing bounties to discovered");
  }

  const stuckSolving = db
    .update(schema.bounties)
    .set({ status: "selected", updatedAt: new Date() })
    .where(eq(schema.bounties.status, "solving"))
    .returning({ id: schema.bounties.id })
    .all();

  if (stuckSolving.length > 0) {
    log.info({ count: stuckSolving.length }, "Reset stuck solving bounties to selected");
  }

  // Clean up orphaned pipeline_runs from prior crashes
  const staleTimeout = new Date(Date.now() - config.SOLVE_TIMEOUT_MINUTES * 60 * 1000);
  const staleRuns = db
    .update(schema.pipelineRuns)
    .set({
      status: "failed",
      errorCategory: "timeout",
      errorMessage: "Orphaned run cleaned up on startup",
      completedAt: new Date(),
    })
    .where(
      and(
        eq(schema.pipelineRuns.status, "running"),
        lt(schema.pipelineRuns.startedAt, staleTimeout),
      ),
    )
    .returning({ id: schema.pipelineRuns.id, traceId: schema.pipelineRuns.traceId })
    .all();

  if (staleRuns.length > 0) {
    log.warn({ count: staleRuns.length, runs: staleRuns }, "Cleaned up orphaned pipeline runs");
  }
}

function main() {
  const config = loadConfig();

  log.info(
    {
      requireApproval: config.REQUIRE_APPROVAL,
      autoRespondReviews: config.AUTO_RESPOND_REVIEWS,
      claudeModel: config.CLAUDE_MODEL,
    },
    "Starting Algora Bounty Bot",
  );

  // Reset any bounties stuck in transient states from previous run
  resetStuckBounties();

  // Clear stale solver status files from previous run
  clearSolverStatus().catch(() => {});
  clearSecurityStatus().catch(() => {});
  clearAdversarialReviewStatus().catch(() => {});

  // Analysis runs continuously (no cooldown). This helper ensures only one
  // instance is running at a time and can be called from anywhere.
  let analysisRunning = false;
  function runAnalysisQueue() {
    if (analysisRunning) return;
    analysisRunning = true;
    processAnalysisQueue()
      .catch((err) => log.error({ err }, "Analysis queue error"))
      .finally(() => { analysisRunning = false; });
  }

  // Security analysis runs after HackerOne discovery to assess programs
  let securityAnalysisRunning = false;
  function runSecurityAnalysisQueue() {
    if (securityAnalysisRunning) return;
    securityAnalysisRunning = true;
    processSecurityProgramQueue()
      .catch((err) => log.error({ err }, "Security program analysis queue error"))
      .finally(() => { securityAnalysisRunning = false; });
  }

  // Discovery: per-provider polling with configurable frequency
  const providerSchedules = [
    { name: "Algora", poll: pollAlgora, minutes: config.ALGORA_POLL_MINUTES, enabled: config.ALGORA_ENABLED },
    { name: "GitHub", poll: pollGitHub, minutes: config.GITHUB_SEARCH_POLL_MINUTES, enabled: config.GITHUB_SEARCH_ENABLED },
    { name: "HackerOne", poll: pollHackerOne, minutes: config.HACKERONE_POLL_MINUTES, enabled: config.HACKERONE_ENABLED },
  ] as const;

  for (const { name, poll, minutes, enabled } of providerSchedules) {
    if (!enabled) {
      log.info({ provider: name }, "Provider disabled, skipping cron");
      continue;
    }
    cron.schedule(`*/${minutes} * * * *`, async () => {
      try {
        await poll();
        runAnalysisQueue();
        if (name === "HackerOne") runSecurityAnalysisQueue();
      } catch (err) {
        log.error({ err, provider: name }, `${name} poll error`);
      }
    });
    log.info({ provider: name, minutes }, "Scheduled provider poll");
  }

  // Solver: try to solve next bounty every 10 minutes
  cron.schedule("*/10 * * * *", async () => {
    try {
      await processNextBounty();
    } catch (err) {
      log.error({ err }, "Solver error");
    }
  });

  // Watchdog: detect stalled solves every 5 minutes
  cron.schedule("*/5 * * * *", async () => {
    try {
      const status = await readSolverStatus();
      if (!status.active || !status.startedAt || !status.timeoutMinutes) return;

      const elapsed = Date.now() - new Date(status.startedAt).getTime();
      const limitMs = (status.timeoutMinutes + 5) * 60 * 1000; // timeout + 5min buffer

      if (elapsed > limitMs) {
        log.warn(
          { bountyId: status.bountyId, elapsedMin: Math.round(elapsed / 60000) },
          "Solver appears stalled — resetting stuck bounty",
        );

        // Reset bounty and its pipeline_runs in DB
        if (status.bountyId) {
          const db = getDb();
          db.update(schema.bounties)
            .set({ status: "selected", updatedAt: new Date() })
            .where(eq(schema.bounties.id, status.bountyId))
            .run();

          db.update(schema.pipelineRuns)
            .set({
              status: "failed",
              errorCategory: "timeout",
              errorMessage: "Stalled solve detected by watchdog",
              completedAt: new Date(),
              durationMs: elapsed,
            })
            .where(
              and(
                eq(schema.pipelineRuns.bountyId, status.bountyId),
                eq(schema.pipelineRuns.status, "running"),
                eq(schema.pipelineRuns.stage, "solve"),
              ),
            )
            .run();
        }

        // Clear solver status file
        await clearSolverStatus();
      }
    } catch (err) {
      log.error({ err }, "Watchdog error");
    }
  });

  // Security auto-hunt: triggers immediately after previous hunt's evaluation pipeline completes
  let autoHuntScheduled = false;
  let dailyHuntCount = 0;
  let dailyHuntResetDate = new Date().toDateString();

  async function runAutoHuntLoop() {
    if (autoHuntScheduled) return;
    autoHuntScheduled = true;
    try {
      while (true) {
        const currentConfig = getConfig();
        if (!currentConfig.SECURITY_AUTO_HUNT_ENABLED) break;

        // Reset daily counter at midnight
        const today = new Date().toDateString();
        if (today !== dailyHuntResetDate) {
          dailyHuntCount = 0;
          dailyHuntResetDate = today;
        }

        // Enforce daily hunt budget
        if (dailyHuntCount >= currentConfig.SECURITY_MAX_DAILY_HUNTS) {
          log.info(
            { dailyHuntCount, max: currentConfig.SECURITY_MAX_DAILY_HUNTS },
            "Daily hunt budget exhausted — pausing auto-hunt until tomorrow",
          );
          break;
        }

        const program = pickBestProgram();
        if (!program) {
          log.info("No eligible programs for auto-hunt — waiting 5 min for assessments/cooldowns");
          await new Promise((r) => setTimeout(r, 5 * 60 * 1000));
          continue;
        }

        log.info({ name: program.name, programId: program.id, dailyHuntCount }, "Auto-launching security hunt");
        try {
          await huntProgram(program, "auto");
          dailyHuntCount++;
        } catch (err: any) {
          if (err.message?.includes("already busy")) {
            log.info("Solver busy — waiting 2 min before retrying");
            await new Promise((r) => setTimeout(r, 2 * 60 * 1000));
            continue;
          }
          log.error({ err, programId: program.id }, "Security hunt error — skipping program, continuing loop");
          continue;
        }

        // Run adversarial review on report_ready findings from this hunt
        try {
          await processAdversarialQueue(program.id);
        } catch (err) {
          log.error({ err }, "Post-hunt adversarial review error");
        }

        // Loop immediately to pick next program (no waiting)
      }
    } finally {
      autoHuntScheduled = false;
    }
  }

  // Check every 30 seconds if auto-hunt should start (lightweight check)
  cron.schedule("*/1 * * * *", () => {
    const currentConfig = getConfig();
    if (!currentConfig.SECURITY_AUTO_HUNT_ENABLED) return;
    runAutoHuntLoop().catch((err) => log.error({ err }, "Auto-hunt loop error"));
  });

  // Security solver watchdog: detect stalled hunts every 5 minutes
  cron.schedule("*/5 * * * *", async () => {
    try {
      const status = await readSecuritySolverStatus();
      if (!status.active || !status.startedAt || !status.timeoutMinutes) return;

      const elapsed = Date.now() - new Date(status.startedAt).getTime();
      const limitMs = (status.timeoutMinutes + 5) * 60 * 1000;

      if (elapsed > limitMs) {
        log.warn(
          { programId: status.programId, elapsedMin: Math.round(elapsed / 60000) },
          "Security solver appears stalled — force stopping",
        );
        await forceStopSecuritySolver();
      }
    } catch (err) {
      log.error({ err }, "Security watchdog error");
    }
  });

  // Adversarial review only runs after hunts (triggered in runAutoHuntLoop above).
  // No cron — findings should be reviewed exactly once, not repeatedly.

  // Security submission status poller: check HackerOne for triager decisions
  cron.schedule(`*/${config.SECURITY_SUBMISSION_POLL_MINUTES} * * * *`, async () => {
    if (!config.HACKERONE_ENABLED) return;
    try {
      const updated = await pollSubmissionStatuses();
      if (updated > 0) {
        log.info({ updated }, "Submission statuses updated from HackerOne");
      }
    } catch (err) {
      log.error({ err }, "Submission status poll error");
    }
  });

  // Monitor: check PR reviews every 10 minutes
  cron.schedule("*/10 * * * *", async () => {
    try {
      await monitorReviews();
    } catch (err) {
      log.error({ err }, "Monitor error");
    }
  });

  // Start dashboard
  const dashboard = startDashboard(config.DASHBOARD_PORT);

  // Run initial discovery from all enabled providers, then start analysis
  pollAllProviders()
    .then(() => runAnalysisQueue())
    .catch((err) => log.error({ err }, "Initial poll failed"));

  log.info(
    { dashboard: `http://localhost:${config.DASHBOARD_PORT}` },
    "All cron jobs scheduled. Bot is running.",
  );

  // Graceful shutdown
  const shutdown = () => {
    log.info("Shutting down...");
    dashboard.kill();
    cron.getTasks().forEach((task) => task.stop());
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

// Catch stray promises so they don't silently disappear
process.on("unhandledRejection", (reason) => {
  const log = createLogger("orchestrator");
  log.error({ reason }, "Unhandled promise rejection");
});

// Uncaught exceptions leave Node in an undefined state — log and exit.
// Use a process manager (pm2, systemd, Docker) to auto-restart.
process.on("uncaughtException", (err) => {
  const log = createLogger("orchestrator");
  log.error({ err }, "Uncaught exception — shutting down");
  process.exit(1);
});

main();
