import "dotenv/config";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

// Set PROJECT_ROOT so all packages resolve paths correctly
const __filename = fileURLToPath(import.meta.url);
process.env.PROJECT_ROOT = dirname(__filename);

import { readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { execFile } from "node:child_process";
import cron from "node-cron";
import { loadConfig, getConfig, createLogger } from "@bounty/core";
import { pollHackerOne, pollImmunefi, pollHuntr, pollAggregator, pollSubmissionStatuses, backfillSignalRequirements } from "@bounty/security-discovery";
import { processSecurityProgramQueue } from "@bounty/security-analyzer";
import {
  huntProgram,
  pickBestProgram,
  readSecuritySolverStatus,
  clearSecuritySolverStatus as clearSecurityStatus,
  clearAdversarialReviewStatus,
  forceStopSecuritySolver,
  processAdversarialQueue,
} from "@bounty/security-solver";

const log = createLogger("orchestrator");

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

function main() {
  const config = loadConfig();

  log.info(
    {
      claudeModel: config.CLAUDE_MODEL,
      hackeroneEnabled: config.HACKERONE_ENABLED,
      autoHuntEnabled: config.SECURITY_AUTO_HUNT_ENABLED,
    },
    "Starting Security Bounty Hunter",
  );

  // Clear stale solver status files from previous run
  clearSecurityStatus().catch(() => {});
  clearAdversarialReviewStatus().catch(() => {});

  // Clear stale hunt lock from previous run
  try {
    const lockFile = join(dirname(__filename), "data", "security-hunt.lock");
    const raw = readFileSync(lockFile, "utf-8");
    const lock = JSON.parse(raw);
    try {
      process.kill(lock.pid, 0);
      // Process alive — don't remove
    } catch {
      // Process dead — stale lock
      unlinkSync(lockFile);
      log.info({ stalePid: lock.pid }, "Removed stale hunt lock from previous run");
    }
  } catch {}

  // Security analysis runs after HackerOne discovery to assess programs
  let securityAnalysisRunning = false;
  function runSecurityAnalysisQueue() {
    if (securityAnalysisRunning) return;
    securityAnalysisRunning = true;
    processSecurityProgramQueue()
      .catch((err) => log.error({ err }, "Security program analysis queue error"))
      .finally(() => { securityAnalysisRunning = false; });
  }

  // HackerOne discovery polling
  if (config.HACKERONE_ENABLED) {
    cron.schedule(`*/${config.HACKERONE_POLL_MINUTES} * * * *`, async () => {
      try {
        await pollHackerOne();
        await backfillSignalRequirements();
        runSecurityAnalysisQueue();
      } catch (err) {
        log.error({ err }, "HackerOne poll error");
      }
    });
    log.info({ minutes: config.HACKERONE_POLL_MINUTES }, "Scheduled HackerOne poll");
  } else {
    log.info("HackerOne disabled, skipping cron");
  }

  // Immunefi discovery polling (crypto/web3 bounties with source code)
  if (config.IMMUNEFI_ENABLED) {
    cron.schedule(`*/${config.HACKERONE_POLL_MINUTES} * * * *`, async () => {
      try {
        await pollImmunefi();
        runSecurityAnalysisQueue();
      } catch (err) {
        log.error({ err }, "Immunefi poll error");
      }
    });
    log.info("Scheduled Immunefi poll");
  }

  // Huntr discovery polling (AI/ML open source bounties)
  if (config.HUNTR_ENABLED) {
    cron.schedule(`*/${config.HACKERONE_POLL_MINUTES} * * * *`, async () => {
      try {
        await pollHuntr();
        runSecurityAnalysisQueue();
      } catch (err) {
        log.error({ err }, "Huntr poll error");
      }
    });
    log.info("Scheduled Huntr poll");
  }

  // Aggregator discovery polling (Bugcrowd, Intigriti, YesWeHack, Federacy — source code only)
  if (config.AGGREGATOR_ENABLED) {
    cron.schedule(`*/${config.HACKERONE_POLL_MINUTES} * * * *`, async () => {
      try {
        await pollAggregator();
        runSecurityAnalysisQueue();
      } catch (err) {
        log.error({ err }, "Aggregator poll error");
      }
    });
    log.info("Scheduled aggregator poll");
  }

  // Security auto-hunt: triggers immediately after previous hunt's evaluation pipeline completes
  let autoHuntScheduled = false;

  async function runAutoHuntLoop() {
    if (autoHuntScheduled) return;
    autoHuntScheduled = true;
    try {
      while (true) {
        const currentConfig = getConfig();
        if (!currentConfig.SECURITY_AUTO_HUNT_ENABLED) break;

        const program = pickBestProgram();
        if (!program) {
          log.info("No eligible programs for auto-hunt — waiting 5 min for assessments/cooldowns");
          await new Promise((r) => setTimeout(r, 5 * 60 * 1000));
          continue;
        }

        log.info({ name: program.name, programId: program.id }, "Auto-launching security hunt");
        try {
          await huntProgram(program, "auto");
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

  // Check every 1 minute if auto-hunt should start (lightweight config check)
  cron.schedule("*/1 * * * *", () => {
    try {
      const currentConfig = getConfig();
      if (!currentConfig.SECURITY_AUTO_HUNT_ENABLED) return;
      runAutoHuntLoop().catch((err) => log.error({ err }, "Auto-hunt loop error"));
    } catch (err) {
      log.error({ err }, "Auto-hunt cron config read error");
    }
  });

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

  // Start dashboard
  const dashboard = startDashboard(config.DASHBOARD_PORT);

  // Run initial discovery for all enabled providers
  const initialPolls: Promise<void>[] = [];
  if (config.HACKERONE_ENABLED) {
    initialPolls.push(
      pollHackerOne()
        .then(() => { runSecurityAnalysisQueue(); })
        .catch((err) => log.error({ err }, "Initial HackerOne poll failed")),
    );
  }
  if (config.IMMUNEFI_ENABLED) {
    initialPolls.push(
      pollImmunefi()
        .then(() => { runSecurityAnalysisQueue(); })
        .catch((err) => log.error({ err }, "Initial Immunefi poll failed")),
    );
  }
  if (config.HUNTR_ENABLED) {
    initialPolls.push(
      pollHuntr()
        .then(() => { runSecurityAnalysisQueue(); })
        .catch((err) => log.error({ err }, "Initial Huntr poll failed")),
    );
  }
  if (config.AGGREGATOR_ENABLED) {
    initialPolls.push(
      pollAggregator()
        .then(() => { runSecurityAnalysisQueue(); })
        .catch((err) => log.error({ err }, "Initial aggregator poll failed")),
    );
  }

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
