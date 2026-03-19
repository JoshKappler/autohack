import { spawn, type ChildProcess } from "node:child_process";
import { appendFile } from "node:fs/promises";
import { getConfig, createLogger } from "@algora/core";

const log = createLogger("pty-runner");

// Strip ANSI escape sequences to get plain text for parsing
// Covers: CSI sequences, OSC sequences, SGR, cursor movement, etc.
// eslint-disable-next-line no-control-regex
const ANSI_RE = /[\x1B\x9B][\[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nq-uy=><~]/g;

function stripAnsi(str: string): string {
  return str.replace(ANSI_RE, "");
}

function getClaudeEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  const config = getConfig();
  if (config.CLAUDE_BACKEND === "cli") delete env.ANTHROPIC_API_KEY;
  return env;
}

/**
 * Spawn Claude CLI in a PTY so it renders its native rich terminal UI.
 * Uses macOS `script` command to allocate a pseudo-terminal.
 * Output is simultaneously:
 *   1. Piped to process.stdout (user sees rich UI live)
 *   2. Appended to logFile (full session capture with ANSI)
 *   3. ANSI-stripped into a text buffer (returned for parseFindings)
 */
export async function spawnClaudeWithPty(
  prompt: string,
  logFile: string,
  timeoutMs: number,
  onMetrics?: (metrics: { linesOutput: number; lastActivity: string }) => void,
): Promise<string> {
  const config = getConfig();
  const claudePath = process.env.CLAUDE_PATH || "claude";

  const claudeArgs = [
    claudePath,
    "--dangerously-skip-permissions",
    "--model", config.CLAUDE_MODEL,
    "--max-turns", "500",
    "--effort", "high",
    "-",
  ];

  return new Promise<string>((resolve, reject) => {
    // `script -q /dev/null` allocates a PTY on macOS without writing a typescript file.
    // Claude CLI sees a TTY on stdout and renders its full rich UI.
    const child: ChildProcess = spawn("script", ["-q", "/dev/null", ...claudeArgs], {
      cwd: "/tmp/security-audit",
      env: getClaudeEnv(),
      stdio: ["pipe", "pipe", "pipe"],
    });

    // Write prompt to stdin
    child.stdin!.write(prompt);
    child.stdin!.end();

    let textBuffer = "";
    let linesOutput = 0;
    let chunksSinceMetrics = 0;

    child.stdout!.on("data", async (chunk: Buffer) => {
      const raw = chunk.toString();

      // 1. Live display to user's terminal
      process.stdout.write(raw);

      // 2. Append raw output (with ANSI) to log file
      try { await appendFile(logFile, raw); } catch {}

      // 3. Strip ANSI and accumulate for parseFindings
      const stripped = stripAnsi(raw);
      textBuffer += stripped;

      // Count lines for metrics
      const newLines = (stripped.match(/\n/g) || []).length;
      linesOutput += newLines;
      chunksSinceMetrics += newLines;

      if (onMetrics && chunksSinceMetrics >= 5) {
        chunksSinceMetrics = 0;
        onMetrics({ linesOutput, lastActivity: new Date().toISOString() });
      }
    });

    child.stderr!.on("data", async (chunk: Buffer) => {
      const raw = chunk.toString();
      try { await appendFile(logFile, raw); } catch {}
    });

    const timer = setTimeout(() => {
      log.warn("PTY runner timed out, sending SIGTERM");
      child.kill("SIGTERM");
      setTimeout(() => {
        if (!child.killed) child.kill("SIGKILL");
      }, 10_000);
      reject(new Error(`Security solver timed out after ${Math.round(timeoutMs / 60000)} minutes`));
    }, timeoutMs);

    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });

    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0 && code !== null) {
        log.warn({ code }, "Claude CLI exited with non-zero code");
      }
      resolve(textBuffer);
    });
  });
}
