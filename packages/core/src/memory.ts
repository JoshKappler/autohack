import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { existsSync } from "node:fs";
import { createLogger } from "./logger";

const log = createLogger("memory");

interface SolveMemory {
  bountyId: string;
  repo: string;
  language: string | null;
  rewardCents: number;
  feasibilityScore: number | null;
  outcome: "success" | "failed" | "timeout" | "no_changes" | "test_failure" | "git_error";
  errorSummary?: string;
  durationMs?: number;
  timestamp: string;
}

interface ReviewFixMemory {
  bountyId: string;
  repo: string;
  reviewComment: string;
  fixAttempted: boolean;
  fixSucceeded: boolean;
  timestamp: string;
}

interface MemoryStore {
  solveHistory: SolveMemory[];
  reviewFixes: ReviewFixMemory[];
  failedRepos: Record<string, number>; // repo -> failure count
  failedPatterns: string[]; // patterns to avoid (e.g., "requires external API")
}

function getMemoryPath(): string {
  const root = process.env.PROJECT_ROOT || process.cwd();
  return join(root, "data", "memory.json");
}

async function loadMemory(): Promise<MemoryStore> {
  const memPath = getMemoryPath();
  if (!existsSync(memPath)) {
    return { solveHistory: [], reviewFixes: [], failedRepos: {}, failedPatterns: [] };
  }
  try {
    const raw = await readFile(memPath, "utf-8");
    const store = JSON.parse(raw) as MemoryStore;
    // Ensure reviewFixes array exists for older memory files
    if (!store.reviewFixes) store.reviewFixes = [];
    return store;
  } catch {
    return { solveHistory: [], reviewFixes: [], failedRepos: {}, failedPatterns: [] };
  }
}

async function saveMemory(store: MemoryStore): Promise<void> {
  const memPath = getMemoryPath();
  await mkdir(resolve(memPath, ".."), { recursive: true });
  await writeFile(memPath, JSON.stringify(store, null, 2), "utf-8");
}

/**
 * Record the outcome of a solve attempt for future reference.
 */
export async function recordSolveOutcome(entry: SolveMemory): Promise<void> {
  const store = await loadMemory();

  store.solveHistory.push(entry);

  // Track repo-level failure counts
  if (entry.outcome !== "success") {
    const repo = entry.repo;
    store.failedRepos[repo] = (store.failedRepos[repo] ?? 0) + 1;
  }

  // Keep history manageable (last 200 entries)
  if (store.solveHistory.length > 200) {
    store.solveHistory = store.solveHistory.slice(-200);
  }

  await saveMemory(store);
  log.info({ bountyId: entry.bountyId, outcome: entry.outcome }, "Recorded solve outcome");
}

/**
 * Check if a repo has a history of failures, suggesting we should avoid it.
 */
export async function getRepoFailureCount(repo: string): Promise<number> {
  const store = await loadMemory();
  return store.failedRepos[repo] ?? 0;
}

/**
 * Record the outcome of a review fix attempt.
 */
export async function recordReviewFix(entry: ReviewFixMemory): Promise<void> {
  const store = await loadMemory();
  store.reviewFixes.push(entry);
  if (store.reviewFixes.length > 100) {
    store.reviewFixes = store.reviewFixes.slice(-100);
  }
  await saveMemory(store);
  log.info({ bountyId: entry.bountyId, fixSucceeded: entry.fixSucceeded }, "Recorded review fix outcome");
}

/**
 * Get a summary of past performance for logging/analysis.
 */
export async function getPerformanceSummary(): Promise<{
  totalAttempts: number;
  successes: number;
  failures: number;
  successRate: number;
  topFailureReasons: Record<string, number>;
}> {
  const store = await loadMemory();
  const total = store.solveHistory.length;
  const successes = store.solveHistory.filter((s) => s.outcome === "success").length;

  const reasons: Record<string, number> = {};
  for (const entry of store.solveHistory) {
    if (entry.outcome !== "success") {
      reasons[entry.outcome] = (reasons[entry.outcome] ?? 0) + 1;
    }
  }

  return {
    totalAttempts: total,
    successes,
    failures: total - successes,
    successRate: total > 0 ? successes / total : 0,
    topFailureReasons: reasons,
  };
}

/**
 * Generate a learning context string for the solver prompt.
 * Summarizes past performance to help Claude make better decisions.
 */
export async function getLearningContext(): Promise<string> {
  const store = await loadMemory();
  if (store.solveHistory.length === 0) return "";

  const total = store.solveHistory.length;
  const successes = store.solveHistory.filter((s) => s.outcome === "success").length;
  const rate = total > 0 ? ((successes / total) * 100).toFixed(0) : "0";

  const lines: string[] = [
    `## Performance Context (from ${total} past attempts)`,
    `Success rate: ${rate}% (${successes}/${total})`,
  ];

  // Language-level success rates
  const byLang: Record<string, { total: number; success: number }> = {};
  for (const entry of store.solveHistory) {
    const lang = entry.language ?? "unknown";
    if (!byLang[lang]) byLang[lang] = { total: 0, success: 0 };
    byLang[lang].total++;
    if (entry.outcome === "success") byLang[lang].success++;
  }
  const langStats = Object.entries(byLang)
    .filter(([, s]) => s.total >= 2)
    .map(([lang, s]) => `  - ${lang}: ${((s.success / s.total) * 100).toFixed(0)}% (${s.success}/${s.total})`)
    .join("\n");
  if (langStats) lines.push(`By language:\n${langStats}`);

  // Common failure reasons
  const reasons: Record<string, number> = {};
  for (const entry of store.solveHistory) {
    if (entry.outcome !== "success" && entry.errorSummary) {
      const key = entry.errorSummary.slice(0, 80);
      reasons[key] = (reasons[key] ?? 0) + 1;
    }
  }
  const topReasons = Object.entries(reasons)
    .sort(([, a], [, b]) => b - a)
    .slice(0, 3)
    .map(([reason, count]) => `  - (${count}x) ${reason}`)
    .join("\n");
  if (topReasons) lines.push(`Common failure patterns:\n${topReasons}`);

  // Recent review feedback patterns
  if (store.reviewFixes.length > 0) {
    const recentFeedback = store.reviewFixes
      .slice(-5)
      .map((f) => `  - ${f.repo}: "${f.reviewComment.slice(0, 100)}" → ${f.fixSucceeded ? "fixed" : "not fixed"}`)
      .join("\n");
    lines.push(`Recent reviewer feedback:\n${recentFeedback}`);
  }

  return lines.join("\n") + "\n";
}
