const TRANSIENT_MESSAGE_PATTERNS = [
  /rate.?limit/i,
  /too many requests/i,
  /token/i,
  /capacity/i,
  /overloaded/i,
  /\b429\b/,
  /\b529\b/,
  /\b500\b/,
  /\b502\b/,
  /\b503\b/,
  /\b504\b/,
  /timeout/i,
  /SIGTERM/,
  /SIGKILL/,
];

const TRANSIENT_ERROR_CODES = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "ETIMEDOUT",
  "EHOSTUNREACH",
  "EAI_AGAIN",
  "EPIPE",
]);

export function isTransientError(err: unknown): boolean {
  if (err == null) return false;

  const e = err as Record<string, any>;

  // Process was killed (e.g., timeout)
  if (e.killed === true) return true;

  // Node.js system error codes
  if (typeof e.code === "string" && TRANSIENT_ERROR_CODES.has(e.code)) {
    return true;
  }

  // HTTP status codes
  const status = e.status ?? e.statusCode;
  if (typeof status === "number" && (status === 429 || status >= 500)) {
    return true;
  }

  // Message pattern matching
  const message = e.message ?? String(err);
  if (typeof message === "string") {
    return TRANSIENT_MESSAGE_PATTERNS.some((p) => p.test(message));
  }

  return false;
}
