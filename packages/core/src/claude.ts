import { spawn } from "node:child_process";
import { getConfig } from "./config";
import { extractJsonWithKey } from "./json-utils";
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

interface StructuredOutputOpts extends RunClaudeOpts {
  /** Tool name for the structured output call. */
  toolName: string;
  /** JSON Schema for the expected output. */
  inputSchema: Record<string, unknown>;
  /** Key to look for when falling back to text extraction (CLI mode). */
  fallbackKey: string;
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

  // Use prompt caching on system prompts — they're large and stable across batch calls.
  // cache_control: ephemeral keeps the prefix cached for ~5 min, cutting input costs ~90%.
  const systemParam = opts?.systemPrompt
    ? [{ type: "text" as const, text: opts.systemPrompt, cache_control: { type: "ephemeral" as const } }]
    : undefined;

  const response = await client.messages.create({
    model,
    max_tokens: opts?.maxTokens ?? 4096,
    ...(opts?.temperature != null ? { temperature: opts.temperature } : {}),
    ...(systemParam ? { system: systemParam } : {}),
    messages: [{ role: "user", content: prompt }],
  });

  const text =
    response.content[0].type === "text" ? response.content[0].text : "";
  return text.trim();
}

/**
 * Run a prompt through Claude and get structured JSON output.
 *
 * - API mode: Uses tool_use with forced tool_choice for guaranteed valid JSON.
 * - CLI mode: Falls back to text generation + extractJsonWithKey parsing.
 *
 * Returns the parsed object or null if extraction fails.
 */
export async function runClaudeStructured<T = Record<string, unknown>>(
  prompt: string,
  opts: StructuredOutputOpts,
): Promise<T | null> {
  const config = getConfig();

  if (config.CLAUDE_BACKEND === "api") {
    return runClaudeStructuredAPI<T>(prompt, opts);
  }

  // CLI fallback: text generation + JSON extraction
  const text = await runClaudeCLI(prompt, opts);
  return extractJsonWithKey<T>(text, opts.fallbackKey);
}

async function runClaudeStructuredAPI<T>(
  prompt: string,
  opts: StructuredOutputOpts,
): Promise<T | null> {
  const config = getConfig();

  if (!config.ANTHROPIC_API_KEY) {
    throw new Error(
      "CLAUDE_BACKEND=api but ANTHROPIC_API_KEY is not set.",
    );
  }

  log.debug({ tool: opts.toolName }, "Running Claude structured output via API");

  const { default: Anthropic } = await import("@anthropic-ai/sdk");
  const client = new Anthropic({ apiKey: config.ANTHROPIC_API_KEY });

  const model = resolveApiModel(opts.model ?? config.CLAUDE_MODEL);

  const systemParam = opts.systemPrompt
    ? [{ type: "text" as const, text: opts.systemPrompt, cache_control: { type: "ephemeral" as const } }]
    : undefined;

  const response = await client.messages.create({
    model,
    max_tokens: opts.maxTokens ?? 4096,
    ...(opts.temperature != null ? { temperature: opts.temperature } : {}),
    ...(systemParam ? { system: systemParam } : {}),
    messages: [{ role: "user", content: prompt }],
    tools: [
      {
        name: opts.toolName,
        description: `Return structured ${opts.toolName} data.`,
        input_schema: opts.inputSchema as any,
      },
    ],
    tool_choice: { type: "tool" as const, name: opts.toolName },
  });

  const toolBlock = response.content.find((b: any) => b.type === "tool_use");
  if (!toolBlock || toolBlock.type !== "tool_use") {
    log.warn("No tool_use block in structured response, falling back to text extraction");
    const text = response.content.find((b: any) => b.type === "text");
    if (text && text.type === "text") {
      return extractJsonWithKey<T>(text.text, opts.fallbackKey);
    }
    return null;
  }

  return (toolBlock as any).input as T;
}
