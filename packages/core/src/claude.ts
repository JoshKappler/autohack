import { spawn } from "node:child_process";
import { getConfig } from "./config";
import { createLogger } from "./logger";

const log = createLogger("claude");

interface RunClaudeOpts {
  timeoutMs?: number;
  model?: string;
  maxTokens?: number;
  temperature?: number;
  /** When true, omit --dangerously-skip-permissions so Claude runs tool-free (pure text generation). */
  disableTools?: boolean;
  /** System prompt passed via --system-prompt flag (separate from the user message). */
  systemPrompt?: string;
}

/** Map short model names to full API model identifiers. */
function resolveApiModel(name: string): string {
  const map: Record<string, string> = {
    opus: "claude-opus-4-20250514",
    sonnet: "claude-sonnet-4-20250514",
    haiku: "claude-haiku-4-5-20251001",
  };
  return map[name.toLowerCase()] ?? name;
}

/**
 * Run a prompt through Claude, dispatching to CLI or API based on CLAUDE_BACKEND config.
 * Default: CLI (uses Max subscription, no API cost).
 * Fallback: API (uses ANTHROPIC_API_KEY, pay-per-credit).
 */
export async function runClaude(
  prompt: string,
  opts?: RunClaudeOpts,
): Promise<string> {
  const config = getConfig();

  if (config.CLAUDE_BACKEND === "api") {
    return runClaudeAPI(prompt, opts);
  }

  return runClaudeCLI(prompt, opts);
}

function runClaudeCLI(
  prompt: string,
  opts?: RunClaudeOpts,
): Promise<string> {
  const config = getConfig();
  const timeoutMs = opts?.timeoutMs ?? 180_000; // 3 minutes default for CLI
  const model = opts?.model ?? config.CLAUDE_MODEL;
  const claudePath = process.env.CLAUDE_PATH || "claude";

  if (opts?.temperature != null) {
    log.debug({ model, temperature: opts.temperature }, "Running Claude via CLI (Max subscription) — CLI does not support --temperature, output may be non-deterministic");
  } else {
    log.debug({ model }, "Running Claude via CLI (Max subscription)");
  }

  return new Promise((resolve, reject) => {
    // Strip ANTHROPIC_API_KEY from env so CLI uses Max subscription auth
    const env = { ...process.env };
    delete env.ANTHROPIC_API_KEY;

    const args = [
      "--print",
      ...(opts?.disableTools ? [] : ["--dangerously-skip-permissions"]),
      "--model", model,
      "--max-turns", "10",
      ...(opts?.systemPrompt ? ["--system-prompt", opts.systemPrompt] : []),
      "-", // read prompt from stdin
    ];

    const child = spawn(
      claudePath,
      args,
      {
        stdio: ["pipe", "pipe", "pipe"],
        env,
      },
    );

    // Pipe prompt via stdin to avoid ARG_MAX limits on large prompts
    child.stdin.write(prompt);
    child.stdin.end();

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });

    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    // Manual timeout since spawn() doesn't support the timeout option
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error(`Claude CLI timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });

    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) {
        resolve(stdout.trim());
      } else {
        reject(
          new Error(
            `Claude CLI exited with code ${code}: ${stderr || stdout}`,
          ),
        );
      }
    });
  });
}

async function runClaudeAPI(
  prompt: string,
  opts?: RunClaudeOpts,
): Promise<string> {
  const config = getConfig();

  if (!config.ANTHROPIC_API_KEY) {
    throw new Error(
      "CLAUDE_BACKEND=api but ANTHROPIC_API_KEY is not set. Set the key or switch to CLAUDE_BACKEND=cli.",
    );
  }

  log.debug("Running Claude via API");

  // Dynamic import to avoid loading the SDK when using CLI mode
  const { default: Anthropic } = await import("@anthropic-ai/sdk");
  const client = new Anthropic({ apiKey: config.ANTHROPIC_API_KEY });

  const model = resolveApiModel(opts?.model ?? config.CLAUDE_MODEL);

  const response = await client.messages.create({
    model,
    max_tokens: opts?.maxTokens ?? 4096,
    ...(opts?.temperature != null ? { temperature: opts.temperature } : {}),
    ...(opts?.systemPrompt ? { system: opts.systemPrompt } : {}),
    messages: [{ role: "user", content: prompt }],
  });

  const text =
    response.content[0].type === "text" ? response.content[0].text : "";
  return text.trim();
}
