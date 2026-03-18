import "dotenv/config";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

// Set PROJECT_ROOT so all packages resolve paths correctly
const __filename = fileURLToPath(import.meta.url);
process.env.PROJECT_ROOT = dirname(__filename);

import { execFile } from "node:child_process";
import cron from "node-cron";
import { eq, and, gte, sql } from "drizzle-orm";
import { loadConfig, getDb, schema, createLogger } from "@algora/core";
import { pollAlgora, pollGitHub } from "@algora/discovery";
import { processAnalysisQueue } from "@algora/analyzer";
import { processNextBounty, readSolverStatus, clearSolverStatus } from "@algora/solver";
import { monitorReviews } from "@algora/monitor";

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

  // Discovery: fast poll every 5 minutes
  cron.schedule("*/5 * * * *", async () => {
    try {
      await pollAlgora();
      // Kick off analysis immediately after discovering new bounties
      runAnalysisQueue();
    } catch (err) {
      log.error({ err }, "Algora poll error");
    }
  });

  // Discovery: deep GitHub search every hour
  cron.schedule("0 * * * *", async () => {
    try {
      await pollGitHub();
      // Kick off analysis immediately after discovering new bounties
      runAnalysisQueue();
    } catch (err) {
      log.error({ err }, "GitHub poll error");
    }
  });

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

        // Reset bounty in DB
        if (status.bountyId) {
          const db = getDb();
          db.update(schema.bounties)
            .set({ status: "selected", updatedAt: new Date() })
            .where(eq(schema.bounties.id, status.bountyId))
            .run();
        }

        // Clear solver status file
        await clearSolverStatus();
      }
    } catch (err) {
      log.error({ err }, "Watchdog error");
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

  // Run initial discovery immediately, then start analysis
  pollAlgora()
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

main();
