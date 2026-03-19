import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { existsSync } from "node:fs";
import { createLogger } from "./logger";

const log = createLogger("security-memory");

interface SecurityHuntOutcome {
  programId: string;
  programName: string;
  findingsReported: number;
  findingsAccepted: number;
  findingsDuplicate: number;
  findingsRejected: number;
  strategyUsed: "code_review" | "web_testing" | "api_testing" | "mixed";
  timestamp: string;
}

interface SecurityFindingOutcome {
  findingId: string;
  programId: string;
  vulnType: string;
  severity: string;
  submissionResult: "accepted" | "duplicate" | "not_applicable" | "informative" | "pending";
  triagerFeedback?: string;
  timestamp: string;
}

interface NearMiss {
  programId: string;
  title: string;
  vulnType: string;
  reason: "low_confidence" | "low_severity" | "excluded_type" | "adversarial_reject";
  reviewFeedback?: string;
  timestamp: string;
}

interface ProgramNotes {
  vulnTypesFound: string[];
  vulnTypesRejected: string[];
  vulnTypesDuplicated: string[];
  areasInvestigated: string[];
  triagerFeedback: string[];
  lastStrategies: string[];
}

interface SecurityMemoryStore {
  huntHistory: SecurityHuntOutcome[];
  findingOutcomes: SecurityFindingOutcome[];
  duplicatedPatterns: Record<string, number>; // finding title pattern -> duplicate count
  programNotes: Record<string, ProgramNotes>; // programId -> notes
  nearMisses: NearMiss[];
}

function getSecurityMemoryPath(): string {
  const root = process.env.PROJECT_ROOT || process.cwd();
  return join(root, "data", "security-memory.json");
}

async function loadSecurityMemory(): Promise<SecurityMemoryStore> {
  const memPath = getSecurityMemoryPath();
  const empty: SecurityMemoryStore = { huntHistory: [], findingOutcomes: [], duplicatedPatterns: {}, programNotes: {}, nearMisses: [] };
  if (!existsSync(memPath)) {
    return empty;
  }
  try {
    const raw = await readFile(memPath, "utf-8");
    const parsed = JSON.parse(raw);
    // Backfill new fields for old stores
    return { ...empty, ...parsed } as SecurityMemoryStore;
  } catch {
    return empty;
  }
}

async function saveSecurityMemory(store: SecurityMemoryStore): Promise<void> {
  const memPath = getSecurityMemoryPath();
  await mkdir(resolve(memPath, ".."), { recursive: true });
  await writeFile(memPath, JSON.stringify(store, null, 2), "utf-8");
}

/**
 * Record the outcome of a security hunt for future learning.
 */
export async function getSecurityHuntHistory(): Promise<SecurityHuntOutcome[]> {
  const store = await loadSecurityMemory();
  return [...store.huntHistory].reverse();
}

export async function recordSecurityHuntOutcome(entry: SecurityHuntOutcome): Promise<void> {
  const store = await loadSecurityMemory();
  store.huntHistory.push(entry);

  // Keep last 100 entries
  if (store.huntHistory.length > 100) {
    store.huntHistory = store.huntHistory.slice(-100);
  }

  await saveSecurityMemory(store);
  log.info(
    { programId: entry.programId, findings: entry.findingsReported },
    "Recorded security hunt outcome",
  );
}

/**
 * Record the outcome of a submitted finding (accepted, duplicate, rejected, etc.)
 */
export async function recordSecurityFindingOutcome(entry: SecurityFindingOutcome): Promise<void> {
  const store = await loadSecurityMemory();
  store.findingOutcomes.push(entry);

  // Track duplicate patterns
  if (entry.submissionResult === "duplicate") {
    // Normalize title to a pattern (lowercase, strip specifics)
    const pattern = entry.vulnType.toLowerCase();
    store.duplicatedPatterns[pattern] = (store.duplicatedPatterns[pattern] ?? 0) + 1;
  }

  // Keep last 200 entries
  if (store.findingOutcomes.length > 200) {
    store.findingOutcomes = store.findingOutcomes.slice(-200);
  }

  await saveSecurityMemory(store);
  log.info(
    { findingId: entry.findingId, result: entry.submissionResult },
    "Recorded security finding outcome",
  );
}

/**
 * Generate a learning context string for the security hunt prompt.
 * Summarizes past performance to help Claude make better decisions.
 */
export async function getSecurityLearningContext(): Promise<string> {
  const store = await loadSecurityMemory();
  if (store.huntHistory.length === 0 && store.findingOutcomes.length === 0) return "";

  const lines: string[] = [];

  // Hunt summary
  if (store.huntHistory.length > 0) {
    const totalHunts = store.huntHistory.length;
    const totalFindings = store.huntHistory.reduce((s, h) => s + h.findingsReported, 0);
    const productiveHunts = store.huntHistory.filter((h) => h.findingsReported > 0).length;

    lines.push(`## Learning Context (from ${totalHunts} past security hunts)`);
    lines.push(
      `Hunt productivity: ${((productiveHunts / totalHunts) * 100).toFixed(0)}% of hunts found something (${totalFindings} total findings)`,
    );

    // Strategy breakdown
    const byStrategy: Record<string, { hunts: number; findings: number }> = {};
    for (const h of store.huntHistory) {
      if (!byStrategy[h.strategyUsed]) byStrategy[h.strategyUsed] = { hunts: 0, findings: 0 };
      byStrategy[h.strategyUsed].hunts++;
      byStrategy[h.strategyUsed].findings += h.findingsReported;
    }
    const strategyStats = Object.entries(byStrategy)
      .map(([s, d]) => `  - ${s}: ${d.findings} findings from ${d.hunts} hunts`)
      .join("\n");
    if (strategyStats) lines.push(`By strategy:\n${strategyStats}`);
  }

  // Finding outcomes
  if (store.findingOutcomes.length > 0) {
    const total = store.findingOutcomes.length;
    const accepted = store.findingOutcomes.filter((f) => f.submissionResult === "accepted").length;
    const duplicates = store.findingOutcomes.filter((f) => f.submissionResult === "duplicate").length;
    const rejected = store.findingOutcomes.filter(
      (f) => f.submissionResult === "not_applicable" || f.submissionResult === "informative",
    ).length;

    lines.push(
      `Submission results: ${accepted} accepted, ${duplicates} duplicates, ${rejected} rejected out of ${total} submitted`,
    );

    if (accepted > 0) {
      const acceptedTypes = store.findingOutcomes
        .filter((f) => f.submissionResult === "accepted")
        .map((f) => f.vulnType)
        .slice(-5);
      lines.push(`Accepted vuln types: ${acceptedTypes.join(", ")}`);
    }
  }

  // Duplicate patterns to avoid
  const dupPatterns = Object.entries(store.duplicatedPatterns)
    .sort(([, a], [, b]) => b - a)
    .slice(0, 5);
  if (dupPatterns.length > 0) {
    const dupLines = dupPatterns.map(([p, c]) => `  - "${p}" (${c}x duplicate)`).join("\n");
    lines.push(`Commonly duplicated (avoid these):\n${dupLines}`);
  }

  // Last 3 hunt outcomes
  const recentHunts = store.huntHistory.slice(-3);
  if (recentHunts.length > 0) {
    const recentLines = recentHunts
      .map(
        (h) =>
          `  - ${h.programName}: ${h.findingsReported} findings via ${h.strategyUsed} (${h.timestamp.slice(0, 10)})`,
      )
      .join("\n");
    lines.push(`Recent hunts:\n${recentLines}`);
  }

  // Triager feedback from recent submissions
  const recentFeedback = store.findingOutcomes
    .filter((f) => f.triagerFeedback)
    .slice(-3);
  if (recentFeedback.length > 0) {
    const fbLines = recentFeedback
      .map(
        (f) =>
          `  - ${f.vulnType} → ${f.submissionResult}: "${f.triagerFeedback!.slice(0, 120)}"`,
      )
      .join("\n");
    lines.push(`Recent triager feedback:\n${fbLines}`);
  }

  // Confidence calibration: show actual acceptance rate
  if (store.findingOutcomes.length >= 5) {
    const total = store.findingOutcomes.length;
    const accepted = store.findingOutcomes.filter((f) => f.submissionResult === "accepted").length;
    const rate = (accepted / total * 100).toFixed(0);
    lines.push(`Confidence calibration: ${rate}% actual acceptance rate across ${total} submissions. Calibrate your confidence scores accordingly — if you're typically overconfident, set a higher bar.`);
  }

  return lines.join("\n") + "\n";
}

/**
 * Record a near-miss finding (filtered by quality gate or rejected by adversarial review).
 * These can inform future hunts on the same program.
 */
export async function recordNearMiss(entry: NearMiss): Promise<void> {
  const store = await loadSecurityMemory();
  store.nearMisses.push(entry);

  // Keep last 100 entries
  if (store.nearMisses.length > 100) {
    store.nearMisses = store.nearMisses.slice(-100);
  }

  await saveSecurityMemory(store);
  log.info(
    { programId: entry.programId, title: entry.title, reason: entry.reason },
    "Recorded near-miss finding",
  );
}

/**
 * Update per-program notes with hunt outcomes.
 * Call after a hunt completes to record what was investigated.
 */
export async function updateProgramNotes(
  programId: string,
  update: {
    strategy?: string;
    vulnTypesFound?: string[];
    vulnTypesRejected?: string[];
    vulnTypesDuplicated?: string[];
    areasInvestigated?: string[];
    triagerFeedback?: string;
  },
): Promise<void> {
  const store = await loadSecurityMemory();
  if (!store.programNotes[programId]) {
    store.programNotes[programId] = {
      vulnTypesFound: [],
      vulnTypesRejected: [],
      vulnTypesDuplicated: [],
      areasInvestigated: [],
      triagerFeedback: [],
      lastStrategies: [],
    };
  }

  const notes = store.programNotes[programId];
  if (update.strategy) {
    notes.lastStrategies.push(update.strategy);
    if (notes.lastStrategies.length > 5) notes.lastStrategies = notes.lastStrategies.slice(-5);
  }
  if (update.vulnTypesFound) {
    for (const v of update.vulnTypesFound) {
      if (!notes.vulnTypesFound.includes(v)) notes.vulnTypesFound.push(v);
    }
  }
  if (update.vulnTypesRejected) {
    for (const v of update.vulnTypesRejected) {
      if (!notes.vulnTypesRejected.includes(v)) notes.vulnTypesRejected.push(v);
    }
  }
  if (update.vulnTypesDuplicated) {
    for (const v of update.vulnTypesDuplicated) {
      if (!notes.vulnTypesDuplicated.includes(v)) notes.vulnTypesDuplicated.push(v);
    }
  }
  if (update.areasInvestigated) {
    for (const a of update.areasInvestigated) {
      if (!notes.areasInvestigated.includes(a)) notes.areasInvestigated.push(a);
    }
    // Cap at 20 areas
    if (notes.areasInvestigated.length > 20) notes.areasInvestigated = notes.areasInvestigated.slice(-20);
  }
  if (update.triagerFeedback) {
    notes.triagerFeedback.push(update.triagerFeedback);
    if (notes.triagerFeedback.length > 10) notes.triagerFeedback = notes.triagerFeedback.slice(-10);
  }

  await saveSecurityMemory(store);
}

/**
 * Generate per-program context string for the hunt prompt.
 * Summarizes what was previously tried on this specific program.
 */
export async function getSecurityProgramContext(programId: string): Promise<string> {
  const store = await loadSecurityMemory();
  const notes = store.programNotes[programId];
  if (!notes) return "";

  const lines: string[] = [];
  lines.push(`## Program-Specific History (from previous hunts on this program)`);

  if (notes.vulnTypesFound.length > 0) {
    lines.push(`Previously accepted vuln types: ${notes.vulnTypesFound.join(", ")}`);
  }
  if (notes.vulnTypesRejected.length > 0) {
    lines.push(`Previously rejected vuln types (avoid): ${notes.vulnTypesRejected.join(", ")}`);
  }
  if (notes.vulnTypesDuplicated.length > 0) {
    lines.push(`Previously duplicated (definitely avoid): ${notes.vulnTypesDuplicated.join(", ")}`);
  }
  if (notes.areasInvestigated.length > 0) {
    lines.push(`Areas previously investigated: ${notes.areasInvestigated.join(", ")}`);
    lines.push(`Try different areas or go deeper on promising leads that weren't fully explored.`);
  }
  if (notes.triagerFeedback.length > 0) {
    const recent = notes.triagerFeedback.slice(-3);
    lines.push(`Recent triager feedback:\n${recent.map((f) => `  - "${f.slice(0, 150)}"`).join("\n")}`);
  }
  if (notes.lastStrategies.length > 0) {
    lines.push(`Strategies used: ${notes.lastStrategies.join(", ")}`);
  }

  // Include near-misses for this program
  const programNearMisses = store.nearMisses.filter((nm) => nm.programId === programId).slice(-5);
  if (programNearMisses.length > 0) {
    lines.push(`Near-misses from previous hunts (promising leads that didn't qualify):`);
    for (const nm of programNearMisses) {
      lines.push(`  - "${nm.title}" (${nm.vulnType}) — rejected: ${nm.reason}${nm.reviewFeedback ? ` — "${nm.reviewFeedback.slice(0, 100)}"` : ""}`);
    }
    lines.push(`These leads may be worth deeper investigation if you can address the weakness.`);
  }

  return lines.join("\n") + "\n";
}
