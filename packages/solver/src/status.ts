import { writeFile, readFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { existsSync } from "node:fs";
import { createLogger } from "@algora/core";

const log = createLogger("solver-status");

export interface SolverStatus {
  active: boolean;
  bountyId?: string;
  repo?: string;
  issueNumber?: number;
  title?: string;
  rewardCents?: number;
  stage?: string;
  startedAt?: string;
  timeoutMinutes?: number;
  pid?: number;
  linesOutput?: number;
  lastActivity?: string;
}

function getStatusPath(): string {
  const root = process.env.PROJECT_ROOT || process.cwd();
  return join(root, "data", "solver-status.json");
}

export async function writeSolverStatus(status: SolverStatus): Promise<void> {
  const statusPath = getStatusPath();
  await mkdir(join(statusPath, ".."), { recursive: true });
  await writeFile(statusPath, JSON.stringify(status, null, 2), "utf-8");
}

export async function clearSolverStatus(): Promise<void> {
  await writeSolverStatus({ active: false });
}

export async function readSolverStatus(): Promise<SolverStatus> {
  const statusPath = getStatusPath();
  if (!existsSync(statusPath)) {
    return { active: false };
  }
  try {
    const raw = await readFile(statusPath, "utf-8");
    return JSON.parse(raw) as SolverStatus;
  } catch {
    return { active: false };
  }
}
