import { writeFile, readFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { existsSync } from "node:fs";
import { createLogger } from "@bounty/core";

const log = createLogger("security-solver-status");

export interface SecuritySolverStatus {
  active: boolean;
  trigger?: "auto" | "manual";
  // Program-level hunt
  programId?: string;
  programName?: string;
  // Finding-level solve (if working on a specific finding)
  findingId?: string;
  findingTitle?: string;
  severity?: string;
  stage?: string; // "hunting" | "researching" | "drafting" | "reviewing" | "done"
  startedAt?: string;
  timeoutMinutes?: number;
  pid?: number;
  linesOutput?: number;
  lastActivity?: string;
  // Rich activity tracking — mirrors Claude Code's frontend
  currentActivity?: string; // e.g. "Running bash", "Reading file", "Thinking", "Responding"
  currentActivityDetail?: string; // e.g. the command being run, the file being read
  currentActivityStartedAt?: string;
  toolUseCount?: number;
  // Recent activity log for the frontend (last N events)
  recentEvents?: Array<{
    type: "tool_use" | "tool_result" | "thinking" | "text";
    name?: string;
    detail?: string;
    startedAt: string;
    durationMs?: number;
  }>;
}

function getStatusPath(): string {
  const root = process.env.PROJECT_ROOT || process.cwd();
  return join(root, "data", "security-solver-status.json");
}

export async function writeSecuritySolverStatus(status: SecuritySolverStatus): Promise<void> {
  const statusPath = getStatusPath();
  await mkdir(join(statusPath, ".."), { recursive: true });
  await writeFile(statusPath, JSON.stringify(status, null, 2), "utf-8");
}

export async function clearSecuritySolverStatus(): Promise<void> {
  await writeSecuritySolverStatus({ active: false });
}

export async function readSecuritySolverStatus(): Promise<SecuritySolverStatus> {
  const statusPath = getStatusPath();
  if (!existsSync(statusPath)) {
    return { active: false };
  }
  try {
    const raw = await readFile(statusPath, "utf-8");
    return JSON.parse(raw) as SecuritySolverStatus;
  } catch {
    return { active: false };
  }
}

// ── Adversarial Review Status ─────────────────────────────────

export interface AdversarialReviewStatus {
  active: boolean;
  cancelled?: boolean;
  total: number;
  completed: number;
  currentFindingId?: string;
  currentFindingTitle?: string;
  startedAt?: string;
}

function getAdversarialStatusPath(): string {
  const root = process.env.PROJECT_ROOT || process.cwd();
  return join(root, "data", "adversarial-review-status.json");
}

export async function writeAdversarialReviewStatus(status: AdversarialReviewStatus): Promise<void> {
  const statusPath = getAdversarialStatusPath();
  await mkdir(join(statusPath, ".."), { recursive: true });
  await writeFile(statusPath, JSON.stringify(status, null, 2), "utf-8");
}

export async function clearAdversarialReviewStatus(): Promise<void> {
  await writeAdversarialReviewStatus({ active: false, total: 0, completed: 0 });
}

export async function cancelAdversarialReview(): Promise<boolean> {
  const status = await readAdversarialReviewStatus();
  if (!status.active) return false;
  await writeAdversarialReviewStatus({ ...status, cancelled: true });
  return true;
}

export async function readAdversarialReviewStatus(): Promise<AdversarialReviewStatus> {
  const statusPath = getAdversarialStatusPath();
  if (!existsSync(statusPath)) {
    return { active: false, total: 0, completed: 0 };
  }
  try {
    const raw = await readFile(statusPath, "utf-8");
    return JSON.parse(raw) as AdversarialReviewStatus;
  } catch {
    return { active: false, total: 0, completed: 0 };
  }
}
