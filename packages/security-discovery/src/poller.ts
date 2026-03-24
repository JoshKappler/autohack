import { eq, inArray } from "drizzle-orm";
import { getDb, schema, getConfig, createLogger, recordSecurityFindingOutcome, type NewSecurityProgram } from "@bounty/core";
import { fetchPrograms, fetchProgramScopes, fetchProgramDetails, fetchReportStatus, fetchProgramPolicy, fetchProgramResponseEfficiency, fetchProgramSignalRequirement, fetchProgramWeaknesses } from "./hackerone-client";
import { fetchImmunefiPrograms } from "./immunefi-client";
import { fetchHuntrPrograms } from "./huntr-client";
import { fetchAggregatorPrograms } from "./aggregator-client";

const log = createLogger("security-poller");

/**
 * Poll HackerOne for programs, insert/update in securityPrograms table.
 * Returns the number of newly discovered programs.
 */
export async function pollHackerOne(): Promise<number> {
  const config = getConfig();
  if (!config.HACKERONE_ENABLED) return 0;
  if (!config.HACKERONE_USERNAME || !config.HACKERONE_API_TOKEN) {
    log.warn("HackerOne enabled but credentials not set — skipping poll");
    return 0;
  }

  log.info("Starting HackerOne poll");
  const db = getDb();
  const programs = await fetchPrograms();
  let newCount = 0;

  for (const prog of programs) {
    const id = `h1-${prog.handle}`;

    const existing = db
      .select()
      .from(schema.securityPrograms)
      .where(eq(schema.securityPrograms.id, id))
      .get();

    if (existing) {
      // Update if name or reward data changed
      const updates: Record<string, any> = {};
      if (existing.name !== prog.name) updates.name = prog.name;
      if (prog.rewardMinCents != null && existing.rewardMinCents !== prog.rewardMinCents) updates.rewardMinCents = prog.rewardMinCents;
      if (prog.rewardMaxCents != null && existing.rewardMaxCents !== prog.rewardMaxCents) updates.rewardMaxCents = prog.rewardMaxCents;
      if (Object.keys(updates).length > 0) {
        db.update(schema.securityPrograms)
          .set({ ...updates, updatedAt: new Date() })
          .where(eq(schema.securityPrograms.id, id))
          .run();
      }
      continue;
    }

    // Fetch scopes and reward details for new programs
    let scopes: Awaited<ReturnType<typeof fetchProgramScopes>> = [];
    try {
      scopes = await fetchProgramScopes(prog.handle);
    } catch (err) {
      log.warn({ err, handle: prog.handle }, "Failed to fetch scopes — inserting program without scopes");
    }

    let rewardMin = prog.rewardMinCents;
    let rewardMax = prog.rewardMaxCents;
    if (rewardMax == null) {
      try {
        const details = await fetchProgramDetails(prog.handle);
        rewardMin = details.rewardMinCents;
        rewardMax = details.rewardMaxCents;
      } catch (err) {
        log.warn({ err, handle: prog.handle }, "Failed to fetch reward details");
      }
    }

    // Fetch program policy and disclosed reports for duplicate avoidance
    let policy: string | null = null;
    let disclosedReports: Array<{ title: string; severity: string; disclosedAt: string }> = [];
    let disclosedReportCount: number | null = null;
    try {
      const policyData = await fetchProgramPolicy(prog.handle);
      policy = policyData.policy;
      disclosedReports = policyData.disclosedReports;
      disclosedReportCount = policyData.disclosedReportCount;
    } catch (err) {
      log.warn({ err, handle: prog.handle }, "Failed to fetch program policy");
    }

    // Fetch accepted weakness types (CWE categories the program accepts reports for)
    let weaknesses: Array<{ id: number; externalId: string; name: string }> = [];
    try {
      weaknesses = await fetchProgramWeaknesses(prog.handle);
    } catch (err) {
      log.debug({ err, handle: prog.handle }, "Failed to fetch weaknesses");
    }

    const now = new Date();
    const newProgram: NewSecurityProgram = {
      id,
      provider: "hackerone",
      providerProgramId: prog.handle,
      name: prog.name,
      url: prog.url,
      scopeSummary: JSON.stringify({
        scopes,
        ...(policy ? { policy } : {}),
        ...(disclosedReports.length > 0 ? { disclosedReports } : {}),
        ...(weaknesses.length > 0 ? { weaknesses: weaknesses.map(w => w.name) } : {}),
      }),
      rewardMinCents: rewardMin,
      rewardMaxCents: rewardMax,
      launchedAt: prog.startedAcceptingAt ? new Date(prog.startedAcceptingAt) : null,
      disclosedReportCount,
      status: "active",
      discoveredAt: now,
      updatedAt: now,
    };

    db.insert(schema.securityPrograms).values(newProgram).run();
    newCount++;

    // Fetch response efficiency from public GraphQL (no auth needed)
    try {
      const efficiency = await fetchProgramResponseEfficiency(prog.handle);
      if (efficiency != null) {
        db.update(schema.securityPrograms)
          .set({ responseEfficiency: efficiency, updatedAt: now })
          .where(eq(schema.securityPrograms.id, id))
          .run();
      }
    } catch {
      // Non-critical — will be backfilled later
    }

    // Check if program requires Signal score
    try {
      const requiresSignal = await fetchProgramSignalRequirement(prog.handle);
      if (requiresSignal === true) {
        db.update(schema.securityPrograms)
          .set({ requiresSignal: true, updatedAt: now })
          .where(eq(schema.securityPrograms.id, id))
          .run();
        log.info({ id, name: prog.name }, "Program requires Signal score");
      } else if (requiresSignal === false) {
        db.update(schema.securityPrograms)
          .set({ requiresSignal: false, updatedAt: now })
          .where(eq(schema.securityPrograms.id, id))
          .run();
      }
      // null = inconclusive, leave default
    } catch {
      // Non-critical
    }

    log.info(
      { id, name: prog.name, scopes: scopes.length },
      "Discovered new security program",
    );
  }

  // Reconciliation: mark programs no longer listed as archived
  const apiHandles = new Set(programs.map((p) => p.handle));
  const activeDbPrograms = db
    .select({ id: schema.securityPrograms.id, providerProgramId: schema.securityPrograms.providerProgramId })
    .from(schema.securityPrograms)
    .where(eq(schema.securityPrograms.provider, "hackerone"))
    .all();

  let archivedCount = 0;
  const now = new Date();
  for (const dbProg of activeDbPrograms) {
    if (dbProg.providerProgramId && !apiHandles.has(dbProg.providerProgramId)) {
      db.update(schema.securityPrograms)
        .set({ status: "archived", updatedAt: now })
        .where(eq(schema.securityPrograms.id, dbProg.id))
        .run();
      archivedCount++;
    }
  }

  // Backfill reward data for programs missing it
  const backfilled = await backfillSecurityRewards();

  log.info({ newCount, archivedCount, backfilled, total: programs.length }, "HackerOne poll complete");
  return newCount;
}

/**
 * Backfill reward data for HackerOne programs that have null rewardMaxCents.
 * Fetches individual program details from the API. Can be called standalone from the dashboard.
 * Returns the number of programs backfilled.
 */
export async function backfillSecurityRewards(): Promise<number> {
  const db = getDb();
  const config = getConfig();
  if (!config.HACKERONE_USERNAME || !config.HACKERONE_API_TOKEN) {
    log.warn("Cannot backfill rewards — HackerOne credentials not set");
    return 0;
  }

  const missingRewards = db
    .select({
      id: schema.securityPrograms.id,
      providerProgramId: schema.securityPrograms.providerProgramId,
      rewardMaxCents: schema.securityPrograms.rewardMaxCents,
    })
    .from(schema.securityPrograms)
    .where(eq(schema.securityPrograms.provider, "hackerone"))
    .all()
    .filter((p) => p.rewardMaxCents == null);

  log.info({ count: missingRewards.length }, "Backfilling reward data for programs");

  let backfilled = 0;
  let errors = 0;
  for (const prog of missingRewards) {
    if (!prog.providerProgramId) continue;
    try {
      const details = await fetchProgramDetails(prog.providerProgramId);
      if (details.rewardMaxCents != null) {
        db.update(schema.securityPrograms)
          .set({
            rewardMinCents: details.rewardMinCents,
            rewardMaxCents: details.rewardMaxCents,
            updatedAt: new Date(),
          })
          .where(eq(schema.securityPrograms.id, prog.id))
          .run();
        backfilled++;
      }
    } catch (err) {
      errors++;
      log.debug({ err, id: prog.id }, "Failed to backfill reward data");
      // Rate limit: if we hit too many errors, stop
      if (errors > 10) {
        log.warn("Too many backfill errors, stopping early");
        break;
      }
    }
  }

  log.info({ backfilled, total: missingRewards.length, errors }, "Reward backfill complete");
  return backfilled;
}

/**
 * Backfill signal requirements for HackerOne programs that haven't been checked yet.
 * Only checks programs where requiresSignal is still the default (false).
 * Returns the number of programs that were found to require Signal.
 */
export async function backfillSignalRequirements(): Promise<number> {
  const db = getDb();

  // Get all active HackerOne programs that haven't been marked as requiring signal
  // We re-check all false values since the default is false and most were never checked
  const unchecked = db
    .select({
      id: schema.securityPrograms.id,
      name: schema.securityPrograms.name,
      providerProgramId: schema.securityPrograms.providerProgramId,
    })
    .from(schema.securityPrograms)
    .where(eq(schema.securityPrograms.provider, "hackerone"))
    .all()
    .filter((p) => p.providerProgramId != null);

  log.info({ count: unchecked.length }, "Backfilling signal requirements");

  let signalRequired = 0;
  let errors = 0;
  for (const prog of unchecked) {
    if (!prog.providerProgramId) continue;
    try {
      const requires = await fetchProgramSignalRequirement(prog.providerProgramId);
      if (requires !== null) {
        db.update(schema.securityPrograms)
          .set({ requiresSignal: requires, updatedAt: new Date() })
          .where(eq(schema.securityPrograms.id, prog.id))
          .run();
        if (requires) {
          signalRequired++;
          log.info({ id: prog.id, name: prog.name }, "Program requires Signal score");
        }
      }
      // Rate limit: small delay between requests to avoid being blocked
      await new Promise((r) => setTimeout(r, 200));
    } catch (err) {
      errors++;
      log.debug({ err, id: prog.id }, "Failed to check signal requirement");
      if (errors > 10) {
        log.warn("Too many signal backfill errors, stopping early");
        break;
      }
    }
  }

  log.info({ signalRequired, total: unchecked.length, errors }, "Signal requirement backfill complete");
  return signalRequired;
}

/**
 * Map HackerOne report state to our finding status.
 */
function mapH1StateToFindingStatus(state: string): typeof schema.securityFindingStatuses[number] | null {
  switch (state) {
    case "triaged": return "triaged";
    case "resolved": return "accepted";
    case "not-applicable": return "not_applicable";
    case "informative": return "informative";
    case "duplicate": return "duplicate";
    case "spam": return "dismissed";
    case "new": return null; // no change yet
    case "needs-more-info": return null; // keep as submitted, may need follow-up
    default: return null;
  }
}

/**
 * Map HackerOne report state to a submission result for the learning memory.
 */
function mapH1StateToOutcome(state: string): "accepted" | "duplicate" | "not_applicable" | "informative" | "pending" {
  switch (state) {
    case "resolved": return "accepted";
    case "duplicate": return "duplicate";
    case "not-applicable": return "not_applicable";
    case "informative": return "informative";
    default: return "pending";
  }
}

/**
 * Poll HackerOne for status updates on submitted findings.
 * Updates finding statuses and records outcomes in the learning memory.
 * Returns the number of findings that received status updates.
 */
export async function pollSubmissionStatuses(): Promise<number> {
  const config = getConfig();
  if (!config.HACKERONE_USERNAME || !config.HACKERONE_API_TOKEN) return 0;

  const db = getDb();

  // Get all findings in submitted or triaged status (still awaiting final resolution)
  const pendingFindings = db
    .select()
    .from(schema.securityFindings)
    .where(inArray(schema.securityFindings.status, ["submitted", "triaged"]))
    .all();

  if (pendingFindings.length === 0) return 0;

  log.info({ count: pendingFindings.length }, "Polling submission statuses");

  let updated = 0;

  for (const finding of pendingFindings) {
    if (!finding.reportId) continue;

    const reportStatus = await fetchReportStatus(finding.reportId);
    if (!reportStatus) continue;

    const newStatus = mapH1StateToFindingStatus(reportStatus.state);
    if (!newStatus) continue; // no meaningful change

    // Only update if status actually changed
    if (newStatus === finding.status) continue;

    const updateData: Record<string, any> = {
      status: newStatus,
      updatedAt: new Date(),
    };

    // Record bounty amount if rewarded
    if (reportStatus.bountyAmountCents != null && reportStatus.bountyAmountCents > 0) {
      updateData.rewardedCents = reportStatus.bountyAmountCents;
      if (newStatus !== "accepted") {
        updateData.status = "rewarded";
      }
    }

    db.update(schema.securityFindings)
      .set(updateData)
      .where(eq(schema.securityFindings.id, finding.id))
      .run();

    log.info(
      {
        findingId: finding.id,
        reportId: finding.reportId,
        oldStatus: finding.status,
        newStatus: updateData.status,
        bounty: reportStatus.bountyAmountCents,
      },
      "Finding status updated from HackerOne",
    );

    // Record outcome in learning memory (this is the critical missing feedback loop)
    const outcome = mapH1StateToOutcome(reportStatus.state);
    if (outcome !== "pending") {
      await recordSecurityFindingOutcome({
        findingId: finding.id,
        programId: finding.programId ?? "",
        vulnType: finding.vulnerabilityType ?? "unknown",
        severity: finding.severity ?? "medium",
        submissionResult: outcome,
        triagerFeedback: reportStatus.triagerFeedback,
        timestamp: new Date().toISOString(),
      }).catch((err) => log.warn({ err, findingId: finding.id }, "Failed to record finding outcome"));
    }

    updated++;

    // Rate limit: 1 request per second
    await new Promise((r) => setTimeout(r, 1000));
  }

  log.info({ updated, total: pendingFindings.length }, "Submission status poll complete");
  return updated;
}

/**
 * Backfill response efficiency for HackerOne programs that have null responseEfficiency.
 * Uses the public GraphQL API (no auth needed). Throttled to avoid rate limiting.
 * Returns the number of programs backfilled.
 */
export async function backfillResponseEfficiency(): Promise<number> {
  const db = getDb();

  const missingEfficiency = db
    .select({
      id: schema.securityPrograms.id,
      providerProgramId: schema.securityPrograms.providerProgramId,
      responseEfficiency: schema.securityPrograms.responseEfficiency,
    })
    .from(schema.securityPrograms)
    .where(eq(schema.securityPrograms.provider, "hackerone"))
    .all()
    .filter((p) => p.responseEfficiency == null);

  if (missingEfficiency.length === 0) return 0;

  log.info({ count: missingEfficiency.length }, "Backfilling response efficiency");

  let backfilled = 0;
  let errors = 0;
  for (const prog of missingEfficiency) {
    if (!prog.providerProgramId) continue;
    try {
      const efficiency = await fetchProgramResponseEfficiency(prog.providerProgramId);
      if (efficiency != null) {
        db.update(schema.securityPrograms)
          .set({ responseEfficiency: efficiency, updatedAt: new Date() })
          .where(eq(schema.securityPrograms.id, prog.id))
          .run();
        backfilled++;
      }
    } catch {
      errors++;
      if (errors > 10) {
        log.warn("Too many backfill errors, stopping early");
        break;
      }
    }
    // Throttle: 500ms between requests
    await new Promise((r) => setTimeout(r, 500));
  }

  log.info({ backfilled, total: missingEfficiency.length, errors }, "Response efficiency backfill complete");
  return backfilled;
}

// ── Immunefi Polling ──────────────────────────────────────────

/**
 * Poll Immunefi for bounty programs. All programs have source code (smart contracts).
 * Returns the number of newly discovered programs.
 */
export async function pollImmunefi(): Promise<number> {
  const config = getConfig();
  if (!config.IMMUNEFI_ENABLED) return 0;

  log.info("Starting Immunefi poll");
  const db = getDb();
  const programs = await fetchImmunefiPrograms();
  let newCount = 0;

  for (const prog of programs) {
    const id = `immunefi-${prog.handle}`;

    const existing = db
      .select()
      .from(schema.securityPrograms)
      .where(eq(schema.securityPrograms.id, id))
      .get();

    if (existing) {
      // Update rewards if changed
      if (prog.rewardMaxCents != null && existing.rewardMaxCents !== prog.rewardMaxCents) {
        db.update(schema.securityPrograms)
          .set({ rewardMaxCents: prog.rewardMaxCents, rewardMinCents: prog.rewardMinCents, updatedAt: new Date() })
          .where(eq(schema.securityPrograms.id, id))
          .run();
      }
      continue;
    }

    // Build scopes from assets
    const scopes = prog.assets.map(a => ({
      assetType: a.assetType === "smart_contract" ? "SOURCE_CODE" : a.assetType,
      assetIdentifier: a.assetIdentifier,
      eligibleForBounty: a.eligibleForBounty,
    }));

    const now = new Date();
    const newProgram: NewSecurityProgram = {
      id,
      provider: "immunefi",
      providerProgramId: prog.handle,
      name: prog.name,
      url: prog.url,
      scopeSummary: JSON.stringify({ scopes }),
      rewardMinCents: prog.rewardMinCents,
      rewardMaxCents: prog.rewardMaxCents,
      launchedAt: prog.launchedAt ? new Date(prog.launchedAt) : null,
      requiresSignal: false, // Immunefi has no signal requirement
      status: "active",
      discoveredAt: now,
      updatedAt: now,
    };

    db.insert(schema.securityPrograms).values(newProgram).run();
    newCount++;

    log.debug({ id, name: prog.name, assets: scopes.length }, "Discovered new Immunefi program");
  }

  log.info({ newCount, total: programs.length }, "Immunefi poll complete");
  return newCount;
}

// ── Huntr Polling ─────────────────────────────────────────────

/**
 * Poll Huntr for AI/ML open source bounty programs.
 * All programs are GitHub repos with source code.
 * Returns the number of newly discovered programs.
 */
export async function pollHuntr(): Promise<number> {
  const config = getConfig();
  if (!config.HUNTR_ENABLED) return 0;

  log.info("Starting Huntr poll");
  const db = getDb();
  const programs = await fetchHuntrPrograms();
  let newCount = 0;

  for (const prog of programs) {
    const id = `huntr-${prog.handle}`;

    const existing = db
      .select()
      .from(schema.securityPrograms)
      .where(eq(schema.securityPrograms.id, id))
      .get();

    if (existing) continue; // Huntr programs are stable, no need to update

    const scopes = [];
    if (prog.repoUrl) {
      scopes.push({
        assetType: "SOURCE_CODE",
        assetIdentifier: prog.repoUrl,
        eligibleForBounty: true,
      });
    }

    const now = new Date();
    const newProgram: NewSecurityProgram = {
      id,
      provider: "huntr",
      providerProgramId: prog.handle,
      name: prog.name,
      url: prog.url,
      scopeSummary: JSON.stringify({ scopes }),
      rewardMinCents: prog.rewardMinCents,
      rewardMaxCents: prog.rewardMaxCents,
      requiresSignal: false,
      status: "active",
      discoveredAt: now,
      updatedAt: now,
    };

    db.insert(schema.securityPrograms).values(newProgram).run();
    newCount++;

    log.debug({ id, name: prog.name, repoUrl: prog.repoUrl }, "Discovered new Huntr program");
  }

  log.info({ newCount, total: programs.length }, "Huntr poll complete");
  return newCount;
}

// ── Aggregator Polling ────────────────────────────────────────

/**
 * Poll the bounty-targets-data aggregator for programs from Bugcrowd, Intigriti,
 * YesWeHack, and Federacy. Only imports programs with source code in scope.
 * Returns the number of newly discovered programs.
 */
export async function pollAggregator(): Promise<number> {
  const config = getConfig();
  if (!config.AGGREGATOR_ENABLED) return 0;

  log.info("Starting aggregator poll");
  const db = getDb();
  const programs = await fetchAggregatorPrograms({ sourceCodeOnly: true });
  let newCount = 0;

  for (const prog of programs) {
    const id = `${prog.provider}-${prog.handle}`;

    const existing = db
      .select()
      .from(schema.securityPrograms)
      .where(eq(schema.securityPrograms.id, id))
      .get();

    if (existing) continue;

    const now = new Date();
    const newProgram: NewSecurityProgram = {
      id,
      provider: prog.provider as any,
      providerProgramId: prog.handle,
      name: prog.name,
      url: prog.url,
      scopeSummary: JSON.stringify({ scopes: prog.scopes }),
      rewardMaxCents: prog.rewardMaxCents,
      requiresSignal: false,
      status: "active",
      discoveredAt: now,
      updatedAt: now,
    };

    db.insert(schema.securityPrograms).values(newProgram).run();
    newCount++;

    log.debug({ id, name: prog.name, provider: prog.provider }, "Discovered new aggregator program");
  }

  log.info({ newCount, total: programs.length }, "Aggregator poll complete");
  return newCount;
}

/**
 * Poll all security bounty providers.
 */
export async function pollAllSecurityProviders(): Promise<number> {
  let total = 0;
  try {
    total += await pollHackerOne();
  } catch (err) {
    log.error({ err }, "HackerOne poll failed");
  }

  try {
    total += await pollImmunefi();
  } catch (err) {
    log.error({ err }, "Immunefi poll failed");
  }

  try {
    total += await pollHuntr();
  } catch (err) {
    log.error({ err }, "Huntr poll failed");
  }

  try {
    total += await pollAggregator();
  } catch (err) {
    log.error({ err }, "Aggregator poll failed");
  }

  // Backfill signal requirements for programs that haven't been checked
  try {
    await backfillSignalRequirements();
  } catch (err) {
    log.error({ err }, "Signal requirement backfill failed");
  }

  return total;
}
