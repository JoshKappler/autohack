import { eq, sql } from "drizzle-orm";
import {
  getDb,
  schema,
  getConfig,
  createLogger,
  generateTraceId,
  classifyError,
  type Bounty,
} from "@algora/core";
import { scoutRepo, countCompetition } from "./codebase-scout";
import { assessFeasibility } from "./feasibility";

const log = createLogger("ranker");

export async function analyzeAndRank(bounty: Bounty): Promise<void> {
  const db = getDb();
  const traceId = generateTraceId();
  const startTime = Date.now();

  // Record pipeline run for analysis
  const run = db
    .insert(schema.pipelineRuns)
    .values({
      traceId,
      bountyId: bounty.id,
      stage: "analyze",
      status: "running",
      startedAt: new Date(),
    })
    .returning()
    .get();

  // Update status to analyzing
  db.update(schema.bounties)
    .set({ status: "analyzing", updatedAt: new Date() })
    .where(eq(schema.bounties.id, bounty.id))
    .run();

  try {
    // Scout repo info — default to minimal info on failure
    let repoInfo: import("@algora/core").RepoInfo;
    try {
      repoInfo = await scoutRepo(bounty.repoOwner, bounty.repoName);
    } catch (err) {
      log.warn({ err, traceId, bountyId: bounty.id }, "Repo scout failed, using minimal info");
      repoInfo = {
        owner: bounty.repoOwner,
        name: bounty.repoName,
        language: null,
        sizeKb: 0,
        stars: 0,
        hasCI: false,
        openIssues: 0,
      };
    }

    const { attempts, existingPRs } = await countCompetition(
      bounty.repoOwner,
      bounty.repoName,
      bounty.issueNumber,
    );

    const labels: string[] = bounty.labels
      ? JSON.parse(bounty.labels)
      : [];

    // assessFeasibility never throws — always returns a result
    const result = await assessFeasibility(
      bounty.title,
      bounty.body,
      labels,
      repoInfo,
      attempts + existingPRs,
    );

    // Priority score: expected value in dollars (reward × feasibility)
    const priorityScore = (bounty.rewardCents / 100) * result.feasibility;

    db.update(schema.bounties)
      .set({
        status: "selected",
        feasibilityScore: result.feasibility,
        estimatedHours: result.estimatedHours,
        analysisNotes: JSON.stringify({
          approach: result.approach,
          riskFactors: result.riskFactors,
          requiresPlanComment: result.requiresPlanComment,
          attempts,
          existingPRs,
          repoLanguage: repoInfo.language,
          repoStars: repoInfo.stars,
        }),
        priorityScore: priorityScore,
        language: repoInfo.language,
        updatedAt: new Date(),
      })
      .where(eq(schema.bounties.id, bounty.id))
      .run();

    // Record successful analysis run
    db.update(schema.pipelineRuns)
      .set({
        status: "success",
        completedAt: new Date(),
        durationMs: Date.now() - startTime,
        logs: `feasibility=${result.feasibility.toFixed(2)}, score=${priorityScore.toFixed(2)}, hours=${result.estimatedHours}`,
      })
      .where(eq(schema.pipelineRuns.id, run.id))
      .run();

    log.info(
      {
        traceId,
        id: bounty.id,
        title: bounty.title,
        feasibility: result.feasibility,
        score: priorityScore.toFixed(2),
      },
      "Analysis complete",
    );
  } catch (err: any) {
    const classified = classifyError(err);
    db.update(schema.pipelineRuns)
      .set({
        status: "failed",
        completedAt: new Date(),
        durationMs: Date.now() - startTime,
        errorCategory: classified.category,
        errorMessage: classified.message,
      })
      .where(eq(schema.pipelineRuns.id, run.id))
      .run();

    log.error({ traceId, err, bountyId: bounty.id }, "Analysis failed");
    throw err;
  }
}

export async function processAnalysisQueue(): Promise<void> {
  const db = getDb();

  // Continuously process all discovered bounties, lowest reward first
  while (true) {
    // Global mutex: don't analyze while solver is active
    const activeSolve = db
      .select()
      .from(schema.bounties)
      .where(sql`${schema.bounties.status} IN ('solving', 'attempting')`)
      .limit(1)
      .get();

    if (activeSolve) {
      log.debug("Solver is active, pausing analysis");
      return;
    }

    const config = getConfig();

    const pending = db
      .select()
      .from(schema.bounties)
      .where(sql`${schema.bounties.status} = 'discovered' AND ${schema.bounties.rewardCents} >= ${config.MIN_BOUNTY_CENTS}`)
      .orderBy(schema.bounties.rewardCents)
      .limit(1)
      .get();

    if (!pending) {
      log.debug("No bounties to analyze");
      return;
    }

    log.info({ title: pending.title, reward: `$${(pending.rewardCents / 100).toFixed(2)}` }, "Analyzing bounty");
    await analyzeAndRank(pending);
  }
}
