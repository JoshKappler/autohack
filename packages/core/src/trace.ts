import { randomBytes } from "node:crypto";

/**
 * Generate a short trace ID for correlating pipeline run logs.
 * Format: "trc_" + 8 hex chars (e.g., "trc_a1b2c3d4")
 */
export function generateTraceId(): string {
  return `trc_${randomBytes(4).toString("hex")}`;
}

/**
 * Classify an error into a category for structured tracking.
 */
export function classifyError(err: unknown): {
  category: string;
  message: string;
} {
  if (err == null) return { category: "unknown", message: "Unknown error" };

  const e = err as Record<string, any>;
  const message = (e.message ?? String(err)).slice(0, 1000);

  // Check for timeout
  if (
    e.killed === true ||
    /timeout|SIGTERM|SIGKILL/i.test(message)
  ) {
    return { category: "timeout", message };
  }

  // Check for no changes
  if (/no changes|no files changed/i.test(message)) {
    return { category: "no_changes", message };
  }

  // Check for validation failures
  if (/test|lint|validation|type.?check/i.test(message)) {
    return { category: "validation", message };
  }

  // Check for transient/network errors
  if (
    /rate.?limit|429|5\d{2}|ECONN|ETIMEDOUT|overloaded|capacity/i.test(message)
  ) {
    return { category: "transient", message };
  }

  // Check for git errors
  if (/git|merge conflict|push|clone/i.test(message)) {
    return { category: "git_error", message };
  }

  return { category: "permanent", message };
}
