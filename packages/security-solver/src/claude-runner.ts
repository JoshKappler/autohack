import { spawn } from "node:child_process";
import { writeFile, mkdir, appendFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import {
  getConfig,
  getDb,
  schema,
  createLogger,
  extractJsonWithKey,
  getSecurityLearningContext,
  getSecurityProgramContext,
  type SecurityFinding,
  type SecurityProgram,
} from "@bounty/core";
import { fetchProgramPolicy } from "@bounty/security-discovery";
import { writeSecuritySolverStatus, clearSecuritySolverStatus } from "./status";

const log = createLogger("security-claude-runner");

/**
 * Vulnerability types that are auto-rejected by the quality gate.
 * Shared between the quality gate filter (index.ts) and the CLAUDE.md workspace file.
 */
export const EXCLUDED_VULN_TYPES = [
  "information disclosure",
  "missing security header",
  "csp",
  "technology fingerprinting",
  "version disclosure",
  "server header",
  "protection mechanism failure",
  "rate limiting",
  "open redirect",
  "clickjacking",
  "cookie",
] as const;

// Track the active child process so it can be killed from outside
let activeChild: ReturnType<typeof spawn> | null = null;

export function setActiveChild(child: ReturnType<typeof spawn> | null): void {
  activeChild = child;
}

export function getActiveChildPid(): number | null {
  return activeChild?.pid ?? null;
}

export function killActiveSecurityProcess(): boolean {
  if (activeChild && !activeChild.killed) {
    log.warn({ pid: activeChild.pid }, "Force-killing active security solver process");
    activeChild.kill("SIGTERM");
    const child = activeChild;
    setTimeout(() => {
      if (!child.killed) {
        child.kill("SIGKILL");
      }
    }, 3000);
    return true;
  }
  return false;
}

function getClaudeEnv() {
  const config = getConfig();
  const env = { ...process.env };
  if (config.CLAUDE_BACKEND === "cli") delete env.ANTHROPIC_API_KEY;
  return env;
}

function getLogDir(): string {
  const root = process.env.PROJECT_ROOT || process.cwd();
  return join(root, "data", "logs");
}

function formatStreamEvent(line: string): string {
  try {
    const event = JSON.parse(line);
    // assistant events contain both text and tool_use blocks in message.content[]
    if (event.type === "assistant" && event.message?.content) {
      const parts: string[] = [];
      for (const c of event.message.content) {
        if (c.type === "text" && c.text) parts.push(c.text);
        if (c.type === "tool_use") {
          const cmd = c.input?.command ?? JSON.stringify(c.input ?? {}).slice(0, 300);
          parts.push(`\n> ${c.name}: ${cmd}\n`);
        }
      }
      return parts.length > 0 ? parts.join("") + "\n" : "";
    }
    // tool_result comes as a "user" event with content array
    if (event.type === "user" && event.message?.content) {
      const results = Array.isArray(event.message.content)
        ? event.message.content.filter((c: any) => c.type === "tool_result")
        : [];
      if (results.length > 0) {
        const parts: string[] = [];
        for (const r of results) {
          const text = typeof r.content === "string"
            ? r.content
            : Array.isArray(r.content)
              ? r.content.map((c: any) => c.text ?? "").join("")
              : JSON.stringify(r.content ?? "");
          const trimmed = text.length > 3000 ? text.slice(0, 3000) + "\n[truncated]\n" : text;
          parts.push(trimmed);
        }
        return parts.join("\n") + "\n";
      }
    }
    if (event.type === "result") {
      // Final result event
      const texts = (event.result?.content ?? [])
        .filter((c: any) => c.type === "text")
        .map((c: any) => c.text);
      return texts.length > 0 ? texts.join("") + "\n" : "";
    }
    return "";
  } catch {
    return line ? line + "\n" : "";
  }
}

function extractTextContent(line: string): string {
  try {
    const event = JSON.parse(line);
    if (event.type === "assistant" && event.message?.content) {
      return event.message.content
        .filter((c: any) => c.type === "text")
        .map((c: any) => c.text)
        .join("");
    }
    if (event.type === "result" && event.result?.content) {
      return event.result.content
        .filter((c: any) => c.type === "text")
        .map((c: any) => c.text)
        .join("");
    }
    return "";
  } catch {
    return "";
  }
}

interface SpawnClaudeOpts {
  systemPrompt?: string;
  maxTurns?: number;
  cwd?: string;
  model?: string;
  effort?: string;
}

/** Activity event emitted for each meaningful stream-json event from Claude. */
export interface ActivityEvent {
  type: "tool_use" | "tool_result" | "thinking" | "text";
  name?: string;
  detail?: string;
  startedAt: string;
  durationMs?: number;
}

/** Rich metrics callback — called on every meaningful event, not just every N lines. */
export interface SpawnMetrics {
  linesOutput: number;
  lastActivity: string;
  currentActivity?: string;
  currentActivityDetail?: string;
  currentActivityStartedAt?: string;
  toolUseCount: number;
  recentEvents: ActivityEvent[];
}

/** Classify a stream-json event into an activity description for the dashboard. */
function classifyStreamEvent(line: string): { activity: string; detail: string; eventType: ActivityEvent["type"] } | null {
  try {
    const event = JSON.parse(line);

    // Helper to classify a tool_use content block
    const classifyToolUse = (toolBlock: any): { activity: string; detail: string; eventType: ActivityEvent["type"] } => {
      const toolName = toolBlock.name ?? "unknown";
      const friendlyNames: Record<string, string> = {
        Bash: "Running command",
        Read: "Reading file",
        Write: "Writing file",
        Edit: "Editing file",
        Grep: "Searching code",
        Glob: "Finding files",
        WebFetch: "Fetching URL",
        WebSearch: "Web search",
        Agent: "Spawning agent",
      };
      const activity = friendlyNames[toolName] ?? `Using ${toolName}`;
      let detail = "";
      if (toolName === "Bash" && toolBlock.input?.command) {
        detail = toolBlock.input.command.length > 120
          ? toolBlock.input.command.slice(0, 120) + "…"
          : toolBlock.input.command;
      } else if (toolName === "Read" && toolBlock.input?.file_path) {
        detail = toolBlock.input.file_path;
      } else if (toolName === "Write" && toolBlock.input?.file_path) {
        detail = toolBlock.input.file_path;
      } else if (toolName === "Edit" && toolBlock.input?.file_path) {
        detail = toolBlock.input.file_path;
      } else if ((toolName === "Grep" || toolName === "Glob") && toolBlock.input?.pattern) {
        detail = toolBlock.input.pattern;
      } else if (toolName === "WebFetch" && toolBlock.input?.url) {
        detail = toolBlock.input.url.length > 120 ? toolBlock.input.url.slice(0, 120) + "…" : toolBlock.input.url;
      } else if (toolBlock.input?.command) {
        detail = toolBlock.input.command.length > 120 ? toolBlock.input.command.slice(0, 120) + "…" : toolBlock.input.command;
      }
      return { activity, detail, eventType: "tool_use" };
    };

    // assistant events contain tool_use and/or text blocks in message.content[]
    if (event.type === "assistant" && event.message?.content) {
      // Check for tool_use blocks first (they take priority over text)
      const toolUse = event.message.content.find((c: any) => c.type === "tool_use");
      if (toolUse) {
        return classifyToolUse(toolUse);
      }
      // Then check for text (thinking)
      const hasText = event.message.content.some((c: any) => c.type === "text" && c.text?.length > 0);
      if (hasText) {
        return { activity: "Thinking", detail: "", eventType: "thinking" };
      }
    }
    // tool_result comes as a "user" event with tool_result content blocks
    if (event.type === "user" && event.message?.content) {
      const hasToolResult = Array.isArray(event.message.content)
        && event.message.content.some((c: any) => c.type === "tool_result");
      if (hasToolResult) {
        return { activity: "Processing result", detail: "", eventType: "tool_result" };
      }
    }
    if (event.type === "result") {
      return { activity: "Finishing response", detail: "", eventType: "text" };
    }
    return null;
  } catch {
    return null;
  }
}

export async function spawnClaude(
  prompt: string,
  logFile: string,
  timeoutMs: number,
  onMetrics?: (metrics: SpawnMetrics) => void,
  opts?: SpawnClaudeOpts,
): Promise<string> {
  // Use PTY runner for rich terminal output (opt-in via SECURITY_LIVE_OUTPUT=1)
  const usePty = process.env.SECURITY_LIVE_OUTPUT === "1";
  log.info({ isTTY: process.stdout.isTTY, usePty }, "spawnClaude: selecting output mode");
  if (usePty) {
    const { spawnClaudeWithPty } = await import(/* webpackIgnore: true */ "./pty-runner.js");
    return spawnClaudeWithPty(prompt, logFile, timeoutMs, onMetrics, opts?.cwd, setActiveChild);
  }

  const config = getConfig();
  const maxTurns = opts?.maxTurns ?? 200;

  return new Promise<string>((resolvePromise, reject) => {
    const claudePath = process.env.CLAUDE_PATH || "claude";
    const child = spawn(
      claudePath,
      [
        "--output-format", "stream-json",
        "--verbose",
        "--dangerously-skip-permissions",
        "--model",
        opts?.model || config.CLAUDE_MODEL,
        "--max-turns", String(maxTurns),
        "--effort", opts?.effort || "high",
        ...(opts?.systemPrompt ? ["--system-prompt", opts.systemPrompt] : []),
        "-",
      ],
      {
        cwd: opts?.cwd ?? "/tmp/security-audit",
        env: getClaudeEnv(),
        stdio: ["pipe", "pipe", "pipe"],
      },
    );

    activeChild = child;

    child.stdin.write(prompt);
    child.stdin.end();

    let textOutput = ""; // Accumulated text for parseFindings
    let linesOutput = 0;
    let toolUseCount = 0;
    let lineBuf = ""; // Buffer for incomplete JSON lines
    let currentActivity = "Starting";
    let currentActivityDetail = "";
    let currentActivityStartedAt = new Date().toISOString();
    const recentEvents: ActivityEvent[] = [];
    const MAX_RECENT_EVENTS = 15;

    // Structured events file for Claude Code-style terminal rendering
    const eventsFile = logFile + ".events.jsonl";
    let toolUseIdx = 0;
    const pendingTools = new Map<number, { tool: string; detail: string; startedAt: number }>();

    const writeEvent = (event: Record<string, any>) => {
      const line = JSON.stringify({ ts: new Date().toISOString(), ...event });
      appendFile(eventsFile, line + "\n").catch(() => {});
    };

    /** Extract tool detail string from a tool_use content block */
    const getToolDetail = (c: any): string => {
      const tool = c.name ?? "unknown";
      return tool === "Bash" && c.input?.command
        ? (c.input.command.length > 200 ? c.input.command.slice(0, 200) + "…" : c.input.command)
        : tool === "Read" && c.input?.file_path ? c.input.file_path
        : tool === "Write" && c.input?.file_path ? c.input.file_path
        : tool === "Edit" && c.input?.file_path ? c.input.file_path
        : (tool === "Grep" || tool === "Glob") && c.input?.pattern ? c.input.pattern
        : tool === "WebFetch" && c.input?.url ? c.input.url
        : c.input?.command ?? "";
    };

    /** Parse a stream-json line and write structured events to .events.jsonl */
    const processStructuredEvent = (line: string) => {
      try {
        const event = JSON.parse(line);

        // assistant events contain text and/or tool_use blocks in message.content[]
        if (event.type === "assistant" && event.message?.content) {
          for (const c of event.message.content) {
            if (c.type === "text" && c.text) {
              writeEvent({ type: "text", content: c.text });
            }
            if (c.type === "tool_use") {
              const tool = c.name ?? "unknown";
              const detail = getToolDetail(c);
              const id = `tu_${toolUseIdx++}`;
              pendingTools.set(toolUseIdx - 1, { tool, detail, startedAt: Date.now() });
              writeEvent({ type: "tool_use", tool, detail, id });
            }
          }
        }
        // tool_result comes as a "user" event with tool_result content blocks
        else if (event.type === "user" && event.message?.content) {
          const results = Array.isArray(event.message.content)
            ? event.message.content.filter((c: any) => c.type === "tool_result")
            : [];
          for (const r of results) {
            const lastIdx = toolUseIdx - 1;
            const pending = pendingTools.get(lastIdx);
            const durationMs = pending ? Date.now() - pending.startedAt : undefined;
            if (pending) pendingTools.delete(lastIdx);

            const text = typeof r.content === "string"
              ? r.content
              : Array.isArray(r.content)
                ? r.content.map((c: any) => c.text ?? "").join("")
                : JSON.stringify(r.content ?? "");
            const resultLines = text.split("\n");
            const summary = resultLines.length > 3
              ? resultLines.slice(0, 3).join("\n") + `\n… (${resultLines.length} lines)`
              : text.length > 500 ? text.slice(0, 500) + `… (${text.length} chars)` : text;

            writeEvent({
              type: "tool_result",
              id: `tu_${lastIdx}`,
              summary,
              durationMs,
            });
          }
        } else if (event.type === "result") {
          const texts = (event.result?.content ?? [])
            .filter((c: any) => c.type === "text")
            .map((c: any) => c.text)
            .join("");
          if (texts) {
            writeEvent({ type: "text", content: texts });
          }
        }
      } catch {
        // Not valid JSON, skip
      }
    };

    const emitMetrics = () => {
      if (!onMetrics) return;
      onMetrics({
        linesOutput,
        lastActivity: new Date().toISOString(),
        currentActivity,
        currentActivityDetail,
        currentActivityStartedAt,
        toolUseCount,
        recentEvents: recentEvents.slice(-MAX_RECENT_EVENTS),
      });
    };

    const onStdout = async (chunk: Buffer) => {
      try {
      const raw = chunk.toString();
      lineBuf += raw;

      // Process complete lines (stream-json emits one JSON object per line)
      const lines = lineBuf.split("\n");
      lineBuf = lines.pop() ?? ""; // Keep incomplete last line in buffer

      let didEmitActivity = false;

      for (const line of lines) {
        if (!line.trim()) continue;

        // Write plain text to .log file (existing behavior)
        const formatted = formatStreamEvent(line);
        if (formatted) {
          linesOutput++;
          appendFile(logFile, formatted).catch(() => {});
        }

        // Accumulate text content for parseFindings
        const textContent = extractTextContent(line);
        if (textContent) textOutput += textContent;

        // Write structured event to .events.jsonl
        processStructuredEvent(line);

        // Classify event for status file activity tracking
        const classified = classifyStreamEvent(line);
        if (classified) {
          const now = new Date().toISOString();

          if (recentEvents.length > 0) {
            const prev = recentEvents[recentEvents.length - 1];
            if (!prev.durationMs) {
              prev.durationMs = new Date(now).getTime() - new Date(prev.startedAt).getTime();
            }
          }

          if (classified.eventType === "tool_use") toolUseCount++;

          currentActivity = classified.activity;
          currentActivityDetail = classified.detail;
          currentActivityStartedAt = now;

          recentEvents.push({
            type: classified.eventType,
            name: classified.activity,
            detail: classified.detail,
            startedAt: now,
          });

          if (recentEvents.length > MAX_RECENT_EVENTS * 2) {
            recentEvents.splice(0, recentEvents.length - MAX_RECENT_EVENTS);
          }

          didEmitActivity = true;
        }
      }

      if (didEmitActivity || linesOutput % 5 === 0) {
        emitMetrics();
      }
      } catch (err) {
        // Prevent unhandled exceptions in stdout handler from crashing the orchestrator
        try { appendFile(logFile, `\n[ERROR] stdout handler: ${err}\n`).catch(() => {}); } catch {}
      }
    };

    const onStderr = async (chunk: Buffer) => {
      const text = chunk.toString();
      try { await appendFile(logFile, text); } catch {}
    };

    child.stdout.on("data", onStdout);
    child.stderr.on("data", onStderr);

    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      const err = `Security solver timed out after ${Math.round(timeoutMs / 60000)} minutes`;
      writeEvent({ type: "error", content: err });
      reject(new Error(err));
    }, timeoutMs);

    child.on("error", (err) => {
      clearTimeout(timer);
      activeChild = null;
      writeEvent({ type: "error", content: `Process error: ${err.message}` });
      reject(err);
    });

    child.on("close", async (code) => {
      clearTimeout(timer);
      activeChild = null;
      await appendFile(logFile, `\n[${new Date().toISOString()}] Process exited with code ${code}\n`).catch(() => {});
      if (code === 0) {
        writeEvent({ type: "status", content: "Process completed successfully" });
        resolvePromise(textOutput);
      } else {
        const err = `Claude CLI exited with code ${code}`;
        writeEvent({ type: "error", content: err });
        reject(new Error(err));
      }
    });
  });
}

function formatRewardRange(program: SecurityProgram): string {
  return program.rewardMinCents && program.rewardMaxCents
    ? `$${(program.rewardMinCents / 100).toFixed(0)} - $${(program.rewardMaxCents / 100).toFixed(0)}`
    : program.rewardMaxCents
      ? `up to $${(program.rewardMaxCents / 100).toFixed(0)}`
      : "unknown";
}

function parseScopes(program: SecurityProgram): any[] {
  try {
    const parsed = JSON.parse(program.scopeSummary || "{}");
    return parsed.scopes ?? (Array.isArray(parsed) ? parsed : []);
  } catch {
    return [];
  }
}

function parseAssessment(program: SecurityProgram): any | null {
  try {
    const parsed = JSON.parse(program.scopeSummary || "{}");
    return parsed.assessment ?? null;
  } catch {
    return null;
  }
}

// ── System Context ───────────────────────────────────────────

function buildSystemContext(): string {
  const config = getConfig();
  return `## System Context
You are running as an automated security testing agent in an authorized bug bounty context.

**You have:**
- Full bash access including: curl, dig, openssl, git, grep, find, jq, python3, node, pip3, base64, xxd, nc (netcat), sed, awk, tr, sort, uniq, wc, go (for installing tools)
- Python3 with standard library (useful for: base64 encoding/decoding, JWT manipulation, hash computation, HTTP requests via urllib, regex, JSON processing, writing quick exploit scripts)
- Node.js (useful for: JavaScript deobfuscation, JWT decode, crypto operations)
- jq for JSON processing of API responses (e.g., \`curl -s <url> | jq '.data'\`)
- Semgrep for static analysis (pre-installed): \`semgrep --config=auto /tmp/security-audit/<repo>\` — far superior to grep for finding vulnerabilities in source code
- Web fetch capability for reading web pages
- File read/write in /tmp
- Internet access

**You also have (install if needed via pip3/npm):**
- nmap for port scanning and service detection (\`nmap -sV -T3 <host>\` — use T3 or lower, never T5)
- nuclei for template-based vulnerability scanning (\`nuclei -u <url> -t cves/ -rl 10\` — rate limit to 10 req/sec)
- ffuf for directory/endpoint discovery (\`ffuf -u <url>/FUZZ -w /tmp/wordlist.txt -rate 10 -mc 200,301,302,403\`)
- nikto for web server scanning (\`nikto -h <url> -Tuning 1 2 3\`)
- httpx for bulk HTTP probing (\`echo <domains> | httpx -silent -status-code\`)

**You do NOT have:**
- A web browser (no JavaScript rendering — you cannot interact with SPAs or JS-heavy apps)
- Burp Suite or Metasploit
- The ability to create accounts on target services (unless explicitly allowed)
- Any pre-existing credentials

**Time budget:** You have approximately ${config.SECURITY_HUNT_TIMEOUT_MINUTES} minutes and 500 tool-use turns total. Pace yourself:
- Phase 0 (study known reports): ~10 turns
- Phase 1 (recon): ~20 turns
- Phase 2 (deep investigation): ~420 turns
- Phase 3 (sanity check): ~10 turns
- Phase 4 (report writing): ~40 turns

Work within \`/tmp/security-audit/\` for any files you clone or create.`;
}

// ── Reviewer System Context ─────────────────────────────────
// Lighter version for the adversarial reviewer — doesn't need tool install guides or time budgets.

export function buildReviewerSystemContext(): string {
  return `## System Context
You are running as an automated adversarial reviewer in an authorized bug bounty context.

**You have:**
- Full bash access: curl, dig, openssl, git, grep, find, jq, python3, node, base64, xxd, nc
- Semgrep for static analysis
- File read/write in /tmp
- Internet access

**You do NOT have:**
- A web browser (no JavaScript rendering)
- Burp Suite or Metasploit
- Pre-existing credentials

**Rate limits (MANDATORY):** curl 1 req/sec per host, nmap T3 max, nuclei -rl 10, ffuf -rate 10

Work within \`/tmp/security-review/\` for any files you create.`;
}

// ── Asset Strategy Blocks ────────────────────────────────────

function detectAssetTypes(scopes: any[]): { hasSourceCode: boolean; hasWebApp: boolean; hasApi: boolean; hasDomain: boolean } {
  return {
    hasSourceCode: scopes.some(
      (s: any) =>
        s.assetType === "SOURCE_CODE" ||
        (s.assetIdentifier && /github\.com|gitlab\.com|bitbucket\.org/.test(s.assetIdentifier)),
    ),
    hasWebApp: scopes.some(
      (s: any) =>
        s.assetType === "URL" ||
        s.assetType === "WILDCARD" ||
        (s.assetIdentifier && /^https?:\/\//.test(s.assetIdentifier)),
    ),
    hasApi: scopes.some(
      (s: any) =>
        s.assetType === "URL" &&
        s.assetIdentifier &&
        /api\.|\/api\/|\/v[0-9]\//.test(s.assetIdentifier),
    ),
    hasDomain: scopes.some(
      (s: any) =>
        s.assetType === "DOMAIN" ||
        s.assetType === "WILDCARD" ||
        (s.assetIdentifier && /^\*\./.test(s.assetIdentifier)),
    ),
  };
}

function buildAssetStrategyBlock(scopes: any[]): string {
  const { hasSourceCode, hasWebApp, hasApi, hasDomain } = detectAssetTypes(scopes);
  const blocks: string[] = [];

  if (hasSourceCode) {
    blocks.push(`### Source Code Analysis (HIGHEST PRIORITY)
Clone repos to /tmp/security-audit/. Understand the stack (README, package manifests, directory structure), then:
1. **Semgrep first:** \`semgrep --config=auto <repo> --json\` for taint-tracked data flow analysis. Also run framework-specific configs (p/express, p/django, p/flask, p/rails). Focus on HIGH/ERROR severity.
2. **Trace user input to sinks:** Find HTTP handlers and follow user-controlled data to dangerous operations (eval, exec, SQL queries, file ops, deserialization, template rendering). This is where real bugs live.
3. **Auth/authz logic:** Missing middleware on routes, broken role checks, JWT misvalidation, timing attacks.
4. **Git history:** \`git log --grep="fix\\|vuln\\|CVE\\|auth\\|sanitize"\` for incomplete patches. \`git blame\` vulnerable lines.
5. **Dependency audit:** npm audit / pip-audit for reachable CVEs (a CVE in an unused dep is not a finding).
Refer to the cheat sheet in /tmp/security-audit/CLAUDE.md for specific grep patterns and commands.`);
  }

  if (hasWebApp) {
    blocks.push(`### Web Application Testing
1. **Fingerprint:** \`curl -sI\` each target. Check /robots.txt, /.env, /.git/config, /graphql.
2. **Auth surface:** Login, signup, password reset flows. Test for enumeration, bypass, token predictability.
3. **Injection testing:** XSS (reflected/stored), SQLi, IDOR (change IDs), path traversal, SSRF on each form/endpoint.
4. **API discovery:** Extract endpoints from JS bundles. Test GraphQL introspection. Check CORS config.
5. **Session management:** Cookie flags, CSRF tokens, session fixation.`);
  }

  if (hasApi) {
    blocks.push(`### API Testing
1. **Find docs:** /swagger, /api-docs, /openapi.json, /redoc.
2. **Auth testing:** Access without auth, with expired/malformed tokens.
3. **IDOR:** Change resource IDs. Test mass assignment (add role/isAdmin fields).
4. **Input fuzzing:** Wrong types, oversized payloads, special chars, null bytes.
5. **SSRF:** Submit internal URLs (169.254.169.254, localhost) in URL parameters.`);
  }

  if (hasDomain) {
    blocks.push(`### Domain Testing
1. **DNS:** Enumerate records (A, CNAME, TXT, MX, NS). Check for subdomain takeover via dangling CNAMEs.
2. **SSL:** Check cert SANs, expiration, cipher strength.
3. **Email:** SPF, DKIM, DMARC records.`);
  }

  if (blocks.length === 0) {
    blocks.push(`### General Strategy
Investigate all in-scope assets systematically. Start with web-accessible targets, then check domains.`);
  }

  return blocks.join("\n\n");
}

// ── Tool Usage Guidance ──────────────────────────────────────

function buildToolGuidance(): string {
  return `## Tools and Rate Limits

You have: curl, dig, openssl, git, grep, find, jq, python3, node, pip3, base64, xxd, nc, semgrep, nmap, nuclei, ffuf, nikto, httpx. Install missing tools via pip3/go install as needed. See /tmp/security-audit/CLAUDE.md for exact commands.

**Rate limits (MANDATORY — violating these = account ban):**
- curl: \`sleep 1\` between requests to the same host
- nmap: T3 or lower (never T4/T5)
- nuclei: always \`-rl 10\`
- ffuf: always \`-rate 10\`
- HTTP 429 → stop that host for 60 seconds. HTTP 500s → back off immediately.
- Total budget: ~500 requests per host per session. Be surgical, not exhaustive.

**FORBIDDEN:** Brute force, DoS, social engineering, out-of-scope testing, sqlmap on production without permission.`;
}

// ── Scope Compliance ─────────────────────────────────────────

function buildScopeCompliance(): string {
  return `## Scope Compliance Rules (MANDATORY)

**Violating these rules will get the account permanently banned.**

1. ONLY test assets explicitly listed in the In-Scope Assets section above
2. Do NOT test any asset marked as out-of-scope
3. Do NOT perform destructive actions (DELETE production data, drop tables, deface pages, etc.)
4. Do NOT attempt denial of service or resource exhaustion
5. Do NOT access other users' real data — only test with your own accounts or test accounts if the program provides them
6. Space requests at least 1 second apart for any single endpoint (\`sleep 1\` between curls)
7. If a wildcard scope is given (e.g., \`*.example.com\`), you may enumerate subdomains but still follow rules 3-6
8. If you find real credentials, PII, or sensitive data, STOP further exploitation immediately and report the finding as-is
9. Respect any additional program rules listed in scope instructions`;
}

// ── Validation Checklist ─────────────────────────────────────

function buildValidationChecklist(): string {
  return `## Validation Checklist (MUST complete before reporting)

For EACH candidate finding, verify ALL of the following. If you cannot answer "yes" to #1-4, do NOT report it.

1. **Legitimate security flaw?** Is this a genuine security vulnerability — not a best-practice violation, not a theoretical concern, but a real flaw that weakens the security posture of the target? If you are confident this is a legitimate security flaw, report it.
2. **In scope?** Does the affected asset exactly match one of the in-scope assets listed above?
3. **Real security impact?** Would exploitation cause actual harm — data breach, account takeover, code execution, privilege escalation, data manipulation? "Best practice" violations are NOT vulnerabilities.
4. **Survived your own falsification attempt?** (See Phase 3 below.) You MUST actively try to disprove each finding before reporting. If you can explain it away, a triager will too.
5. **NOT on the commonly-rejected list?**
   - Missing security headers (X-Frame-Options, X-Content-Type-Options, etc.) without a demonstrated exploit
   - CSP weaknesses without a demonstrated XSS that bypasses the policy
   - Information disclosure of non-sensitive data (server version, tech stack, framework details)
   - Self-XSS (requires victim to paste code in their own browser console)
   - Logout CSRF or login CSRF without demonstrated impact
   - Missing rate limiting without demonstrated abuse scenario
   - SPF/DKIM/DMARC misconfigurations without demonstrated email spoofing
   - CORS misconfiguration without proof of sensitive data exposure on an authenticated endpoint
   - Clickjacking on pages without state-changing actions
   - Exposed Sentry DSN, Google Analytics ID, or other non-secret identifiers
   - Verbose error messages without sensitive data
   - Cookie without Secure/HttpOnly flag alone (without demonstrated exploit)
   - Open ports/services that are intentionally public
   - Subdomain takeover where you cannot demonstrate actual takeover (e.g., CloudFront requiring SSL cert validation)
   - Data "exposed" in API responses that is already visible in the HTML/JS of the page
   - Rate limiting issues on non-sensitive endpoints
   - Open redirect without demonstrated chaining to a higher-impact attack
6. **Medium severity or above?** Informational findings are almost always rejected or marked as duplicates.

### Source Code Findings
For SOURCE_CODE scope assets, the evidence standard is different from web/API testing. You do NOT need to exploit the vulnerability against a live production deployment. Instead, you must demonstrate:
- The vulnerable code path is **reachable** in production (via config files, deployment manifests, default settings, or CI configs)
- The code creates a **real security weakness** (not just a style issue or theoretical concern)
- A local PoC or code trace showing the flaw is sufficient — you do not need to MITM a CDN or compromise production infrastructure to prove a code-level vulnerability

### Severity Calibration
- **Critical:** Remote code execution, authentication bypass affecting all users, SQL injection with data exfiltration, admin access without auth
- **High:** Stored XSS in widely-viewed context, IDOR exposing PII or sensitive data, SSRF to internal services/cloud metadata, privilege escalation to admin
- **Medium:** Reflected XSS with user interaction, CSRF on sensitive state-changing actions, information disclosure of secrets/tokens, path traversal to sensitive files

### Common False Positive Patterns (DO NOT REPORT THESE)
These are the most common findings that get immediately rejected. If your finding resembles any of these, it is almost certainly wrong:
- **"Vulnerable code path exists in source"** — without demonstrating the path is reachable in production. Frameworks, middleware, WAFs, and deployment configs often neutralize source-level vulnerabilities. However, if you can show the code path IS reachable (via config, deployment manifests, or default settings), this IS a valid finding for SOURCE_CODE scope assets.
- **"API returns data it shouldn't"** — but the data is already publicly visible through the normal UI, client-side JS, or public documentation.
- **"No rate limiting on endpoint X"** — rate limiting is almost never a valid finding unless you can demonstrate a concrete abuse scenario with real impact.
- **"SSRF via user-controlled URL parameter"** — but the server validates/restricts the URL, or internal services are not reachable through it.
- **"SQL injection via parameter X"** — but you only tested with a single quote and saw an error message, without actually extracting data or proving injection.
- **"XSS in parameter X"** — but the payload is reflected in a non-rendered context, or CSP/encoding prevents execution.
- **"Sensitive data in response"** — but it's the user's own data returned to them through normal application flow.
- **"Hardcoded secret in source code"** — but it's a test/example value, already rotated, or a non-secret identifier.`;
}

// ── Duplicate Avoidance ──────────────────────────────────────

function buildDuplicateAvoidance(): string {
  return `## Duplicate Avoidance

Before reporting, consider whether this is likely already known:

1. **The 10-minute test:** Would a junior security researcher find this in their first 10 minutes of looking? If yes, it's almost certainly already reported on any program older than a few months.
2. **Heavily-duplicated categories** (on established programs):
   - Subdomain takeover on major companies — heavily hunted by thousands of researchers
   - CSP weaknesses — reported on day 1 of every program
   - Missing security headers — the most commonly duplicated finding category
   - Information disclosure via response headers — extremely common
   - Rate limiting issues — very common duplicate
   - Email security (SPF/DKIM/DMARC) — commonly reported
3. **For established programs (> 1 year old):** Only report MEDIUM or above. Low-severity findings on mature programs are duplicates 90%+ of the time.
4. **Focus on depth over breadth:** One deep, well-researched finding in application logic or source code is worth more than ten surface-level observations that every automated scanner finds.`;
}

// ── Hunter System Prompt ─────────────────────────────────────
// Stable behavioral instructions that persist in the system prompt across all turns.
// Separated from per-program context so they survive context window compression.

export function buildHunterSystemPrompt(minConfidence?: number): string {
  const confidenceThreshold = minConfidence ?? 0.80;
  return `You are an expert bug bounty hunter conducting authorized security testing. Your job is to find REAL, REPRODUCIBLE vulnerabilities in a bug bounty program's in-scope assets and produce professional submission-ready reports.

${buildSystemContext()}

${buildScopeCompliance()}

${buildToolGuidance()}

${buildValidationChecklist()}

${buildDuplicateAvoidance()}

## Context Window Management
You have 500 turns but a finite context window. Be strategic:
- Use subagents (Agent tool) for parallel exploration of different areas of a codebase
- When reviewing source code, grep for vulnerability patterns first, then read only the relevant functions — don't read entire files unless they're small
- After finishing each investigation area, write a brief summary of findings to /tmp/security-audit/CLAUDE.md — this file persists across context window scrolling
- Don't rely on scrolling back to earlier output for important details

## Output Format

Your report will be submitted directly to HackerOne. Write it in the exact format below. The sections map to HackerOne's submission form fields. A triager will read this as-is.

For EACH validated vulnerability, output a report block:

===FINDING_START===
**Title:** [Clear, specific descriptive title, not generic like "XSS vulnerability"]
**Severity:** [critical/high/medium, calibrated to DEMONSTRATED impact using these criteria:
  critical = Full RCE, auth bypass to admin, mass data exfil you actually demonstrated
  high = Significant impact you proved: real data exposure, privilege escalation, account takeover with working PoC
  medium = Real vulnerability with constrained impact: limited data exposure, requires user interaction, affects non-sensitive functionality, or you proved the bug but the practical consequences are moderate
  When in doubt, go one level LOWER than your gut says. Overstated severity is one of the top reasons reports get downgraded or lose credibility. A medium that gets accepted beats a high that gets knocked down.]
**Vulnerability Type:** [CWE ID and name, e.g., "CWE-79: Reflected Cross-Site Scripting"]
**Target Asset:** [The specific URL, endpoint, or file path affected, must match an in-scope asset]
**Confidence:** [0-1, calibrated STRICTLY:
  0.95-1.0 = Fully exploited at runtime, working PoC with confirmed real-world impact, output captured
  0.8-0.94 = Exploited at runtime but edge cases or impact scope uncertain
  ${confidenceThreshold}-0.79 = Strong evidence and partial PoC, but could not fully demonstrate in live environment
  Below ${confidenceThreshold} = Do NOT report]

**Falsification Attempts:**
[REQUIRED. For internal review only, not sent to HackerOne. Briefly describe what you checked to verify this is real and what could disprove it.]

**Vulnerability Information:**
[This is the main body of your HackerOne report. Write it so a triager can read and act on it.

WRITING STYLE (critical -- triagers will reject AI-sounding reports):
- Write like a human security researcher, not a language model. Short, direct sentences. No filler.
- NEVER use em-dashes (--). Use commas, periods, or parentheses instead.
- Use contractions naturally: "doesn't", "isn't", "can't", "won't". Never "does not" or "is not".
- Don't hedge. Say what happens, not what "could potentially" happen.
- Don't pad. One-sentence summary? Fine. One-line fix? Just show it.
- Vary sentence length. Mix short punchy sentences with medium ones.
- Use plain language. Be specific and concrete.

BANNED WORDS AND PHRASES (never use these):
- "It's important to note" / "It should be noted" / "It's worth mentioning"
- "This means that" / "This implies that" / "This suggests that"
- "could potentially" / "might potentially" / "may potentially"
- "essentially" / "furthermore" / "notably" / "additionally" / "moreover"
- "comprehensive" / "robust" / "facilitate" / "leverage" (as verb)
- "in order to" (just say "to")
- "specifically" (as filler) / "ultimately" / "significantly"
- "demonstrates" (say "shows") / "utilizes" (say "uses") / "implements" (say "adds" or "uses")
- "inadvertently" / "subsequently" / "consequently"
- "It is worth noting that" / "As previously mentioned"
- "attack surface" (unless literally describing scope) / "threat actor" (say "attacker")

BAD vs GOOD examples:
- BAD: "This vulnerability could potentially allow an attacker to inadvertently access sensitive user data, which could subsequently lead to a compromise of user accounts."
  GOOD: "An attacker can read any user's profile data by changing the user ID in the request."
- BAD: "It's important to note that the application utilizes a comprehensive authentication mechanism; however, the implementation inadvertently fails to validate the session token."
  GOOD: "The app checks for a session cookie but doesn't validate it. Any string works."
- BAD: "The endpoint facilitates the retrieval of user data -- essentially providing unauthenticated access to sensitive information."
  GOOD: "The /api/users endpoint returns user data without authentication."

SELF-EDIT PASS (mandatory before outputting each finding):
Re-read your entire report. For each sentence ask: would a human researcher write this? If you spot any banned words, em-dashes, or hedging, fix them. A triager reads hundreds of reports. If yours sounds like ChatGPT wrote it, they'll dismiss it before checking the PoC.

Include these sections:

## Summary
2-3 sentences. What the bug is, where it is, what it does. No preamble.

## Vulnerability Details
Technical explanation with affected code paths, files, line numbers. Explain the root cause.

## Steps to Reproduce
1. Exact step-by-step reproduction that a triager can follow
2. Include specific URLs, parameters, headers, payloads
3. Include exact curl commands with their ACTUAL OUTPUT (copy-paste, not paraphrased)

## Proof of Concept
Exact curl commands, code snippets, or tool output that demonstrates the vulnerability. Include ACTUAL command output, not expected output. This is the most important section. Weak PoC = rejected report.

## Remediation
Specific, actionable fix. Code examples where helpful. Don't over-explain.]

**Impact:**
[STANDALONE impact statement for HackerOne's separate Impact field. State what an attacker can actually do, based on what you demonstrated or can concretely conclude from the evidence. Do NOT speculate about worst-case scenarios or chain unproven attack steps. If the impact is limited, say so honestly. A report that accurately describes moderate impact is far more credible than one that inflates it.]
===FINDING_END===

If you find nothing exploitable after thorough investigation, output:

===NO_FINDINGS===
**Assets Investigated:**
[List what you checked]

**Techniques Applied:**
[What methodologies you used]

**Why No Findings:**
[Honest assessment of why: is the program well-hardened? Were assets unreachable? Scope too narrow for automated testing?]
===NO_FINDINGS_END===

**CRITICAL RULES:**
1. Do NOT fabricate findings. Do NOT speculate. Only report what you can PROVE with reproducible evidence and captured output.
2. A false positive is WORSE than no finding. Every false positive wastes triager time, damages reputation, and reduces the chance of future reports being taken seriously.
3. When in doubt, leave it out. Reporting zero findings is the EXPECTED outcome for most hunts on mature programs.
4. For web/API targets: you must demonstrate exploitability at runtime. For SOURCE_CODE targets: demonstrating the vulnerable code path is reachable in production (via config, deployment manifests, default settings) is sufficient. You don't need to exploit it against the live deployment.
5. If your "exploit" requires conditions you cannot verify (specific server config, internal network access, authenticated session), it is NOT validated, unless you can show the condition is the default or documented configuration.
6. You are expected to discard 80-90% of your candidate findings during Phase 3. If you are not discarding most of them, your bar is too low.
7. Your report will be submitted directly to HackerOne as-is. Write it like a human security researcher. No AI slop.
8. SEVERITY MUST MATCH DEMONSTRATED IMPACT. If you found a correctness bug in a security feature but can't show concrete harm to CIA, that's medium at best. If the affected functionality is low-value (e.g., ICMP ping), drop another level. Triagers will downgrade overstated severity, and it hurts credibility on future reports.`;
}

// ── Program Hunt Prompt (User Message) ───────────────────────
// Per-program context that varies each hunt. Paired with the system prompt above.

async function buildProgramHuntPrompt(program: SecurityProgram): Promise<string> {
  const config = getConfig();
  const minConfidence = config.SECURITY_MIN_CONFIDENCE;
  const scopes = parseScopes(program);
  const assessment = parseAssessment(program);
  const rewardRange = formatRewardRange(program);
  const learningContext = await getSecurityLearningContext();
  const programContext = await getSecurityProgramContext(program.id);

  // Fetch live program page from HackerOne for fresh policy and disclosed reports
  let policySection = "";
  let disclosedSection = "";
  const handle = program.providerProgramId;
  if (handle && program.provider === "hackerone") {
    try {
      const { policy, disclosedReports, disclosedReportCount } = await fetchProgramPolicy(handle);
      if (policy) {
        policySection = `\n## Program Policy (fetched live from https://hackerone.com/${handle})\nThe following is the program's official policy. You MUST respect any exclusions or special rules listed here:\n\n${policy.slice(0, 4000)}\n`;
      }
      if (disclosedReports.length > 0) {
        const reportLines = disclosedReports.slice(0, 30).map((r) =>
          `- "${r.title}" (${r.severity ?? "?"}, ${r.disclosedAt ? new Date(r.disclosedAt).toISOString().slice(0, 10) : "?"})`
        );
        disclosedSection = `\n## Known Disclosed Vulnerabilities (${disclosedReportCount} total — DO NOT duplicate)\n${reportLines.join("\n")}\n\nDo NOT report anything that matches or closely resembles these.\n`;
      }
    } catch (err) {
      log.debug({ err, handle }, "Failed to fetch live program page for hunt prompt");
    }
  }

  // Fall back to cached scopeSummary if live fetch failed
  if (!policySection) {
    try {
      const parsed = JSON.parse(program.scopeSummary || "{}");
      if (parsed.policy) {
        policySection = `\n## Program Policy\nThe following is the program's official policy. You MUST respect any exclusions or special rules listed here:\n\n${String(parsed.policy).slice(0, 3000)}\n`;
      }
    } catch {}
  }
  if (!disclosedSection) {
    try {
      const parsed = JSON.parse(program.scopeSummary || "{}");
      if (parsed.disclosedReports && parsed.disclosedReports.length > 0) {
        const reports = parsed.disclosedReports.slice(0, 20);
        disclosedSection = `\n## Known Disclosed Vulnerabilities (already reported — DO NOT duplicate)\n${reports.map((r: any) => `- "${r.title}" (${r.severity ?? "?"}, ${r.disclosedAt ?? "?"})`).join("\n")}\n\nDo NOT report anything that matches or closely resembles these.\n`;
      }
    } catch {}
  }

  // Include previous findings from this program so retries don't duplicate work
  let previousFindingsSection = "";
  const db = getDb();
  const previousFindings = db
    .select({
      title: schema.securityFindings.title,
      severity: schema.securityFindings.severity,
      vulnerabilityType: schema.securityFindings.vulnerabilityType,
      targetAsset: schema.securityFindings.targetAsset,
      status: schema.securityFindings.status,
    })
    .from(schema.securityFindings)
    .where(eq(schema.securityFindings.programId, program.id))
    .all();

  if (previousFindings.length > 0) {
    previousFindingsSection = `\n## Previous Findings on This Program (from prior hunt runs)
Do NOT re-report these. Instead, look for VARIANTS or NEW vulnerability classes.
${previousFindings.map((f, i) => `${i + 1}. [${f.status}] ${f.title} (${f.severity ?? "?"}, ${f.vulnerabilityType ?? "?"}) — target: ${f.targetAsset ?? "?"}`).join("\n")}
`;
  }

  return `## Program: ${program.name}
- **Platform:** ${program.provider}
- **Reward Range:** ${rewardRange}
- **Program URL:** ${program.url ?? "N/A"}
- **Response Efficiency:** ${program.responseEfficiency != null ? `${(program.responseEfficiency * 100).toFixed(0)}%` : "unknown"}

## In-Scope Assets (${scopes.length} total)
${scopes.slice(0, 40).map((s: any, i: number) => `${i + 1}. [${s.assetType}] ${s.assetIdentifier}${s.instruction ? ` — ${s.instruction}` : ""}`).join("\n") || "No scope information available"}
${scopes.length > 40 ? `... and ${scopes.length - 40} more assets` : ""}

${assessment ? `## Prior Assessment
- **Opportunity Score:** ${(assessment.opportunityScore * 100).toFixed(0)}%
- **Top Targets:** ${(assessment.topTargets ?? []).map((t: any) => `${t.asset} (${t.reasoning})`).join("; ") || "none"}
- **Tech Stack:** ${(assessment.techStack ?? []).join(", ") || "unknown"}
- **Attack Surface:** ${assessment.attackSurface ?? "unknown"}
- **Recommended Approach:** ${assessment.recommendedApproach ?? "mixed"}` : ""}
${policySection}${disclosedSection}${previousFindingsSection}
${learningContext}
${programContext}

## Methodology — Follow These Phases In Order

### Phase 0: Study Known Reports (FIRST — before any testing)
Before touching any target, study what's already been found on this program:
1. Read ALL disclosed reports listed above. For each one, note: vulnerability type, affected component, attack technique.
2. Build a mental map of the program's known attack surface — what has been reported, what classes of bugs have been found.
3. Identify gaps: what vulnerability classes or components have NOT been covered by existing reports?
4. Your investigation in Phase 2 should focus EXCLUSIVELY on these gaps. If you find something that overlaps with a disclosed report, discard it immediately.
5. On mature programs (>50 disclosed reports), surface-level findings are already taken. You need to go deep into application logic, complex code flows, or novel attack chains.

### Phase 1: Target Selection and Reconnaissance (~5 minutes)
Classify each in-scope asset by type: SOURCE_CODE, WEB_APP, API, DOMAIN, OTHER.

**Priority order:**
1. SOURCE_CODE (GitHub/GitLab repos) — HIGHEST PRIORITY. Clone immediately. Code review finds the deepest bugs.
2. WEB_APP with authentication — test auth flows, IDOR, access control
3. API endpoints — test authorization, input validation, business logic
4. WEB_APP (static/marketing) — lower priority, often well-hardened
5. DOMAIN — check for subdomain takeover, DNS misconfig

For each web/API target, make ONE request (\`curl -sI\`) to fingerprint the tech stack.
**Select the top 3 most promising targets for deep investigation.**

### Phase 2: Deep Investigation (bulk of your time)
Spend the bulk of your effort here. Follow the asset-type-specific strategies below.

${buildAssetStrategyBlock(scopes)}

### Phase 3: Sanity Check (~5 minutes, ~10 turns)
A separate adversarial reviewer will thoroughly verify your findings after this. Your job here is a quick sanity check to avoid obvious waste:

For EACH candidate finding, verify:
1. **Re-run your PoC** one more time. Does the output match what you claim? Copy the ACTUAL output.
2. **Scope check:** Is the target asset in the in-scope list above?
3. **Excluded type check:** Is this vulnerability type on the excluded list (${EXCLUDED_VULN_TYPES.join(", ")})?
4. **Public data check:** Is the "leaked" data already visible through normal app usage?
5. **Confidence ≥ ${minConfidence}?** If not, drop it.

In the **Falsification Attempts** section of your report, briefly describe: what you checked to verify this is real, and what could theoretically disprove it. 2-4 sentences is enough. The adversarial reviewer will do the deep falsification.

Drop anything that fails checks 1-5. Zero findings is the expected outcome for most hunts.

### Phase 4: Report Writing (final ~10 minutes)
Write only findings that survived Phase 3. Quality over quantity — one solid finding beats five weak ones.`;
}

// ── Finding Report Prompt ────────────────────────────────────
// For when we already have a specific finding that needs a full report drafted.

function buildFindingReportPrompt(
  finding: SecurityFinding,
  program: SecurityProgram,
): string {
  const config = getConfig();
  const scopes = parseScopes(program);
  const rewardRange = formatRewardRange(program);

  let notes: any = {};
  try {
    notes = JSON.parse(finding.analysisNotes || "{}");
  } catch {}

  return `You are an expert security researcher conducting authorized bug bounty testing. You have a validated vulnerability finding that needs a professional, submission-ready report.

${buildSystemContext()}

## Program: ${program.name}
- **Platform:** ${program.provider}
- **Reward Range:** ${rewardRange}
- **Program URL:** ${program.url ?? "N/A"}

## In-Scope Assets
${scopes.slice(0, 20).map((s: any) => `- [${s.assetType}] ${s.assetIdentifier}`).join("\n") || "No scope information"}

## Finding to Report
- **Title:** ${finding.title}
- **Severity:** ${finding.severity ?? "unrated"}
- **Vulnerability Type:** ${finding.vulnerabilityType ?? "unknown"}
- **Target Asset:** ${finding.targetAsset ?? "unknown"}
- **Confidence:** ${finding.confidenceScore != null ? `${(finding.confidenceScore * 100).toFixed(0)}%` : "N/A"}
- **Description:** ${finding.description ?? "(no description)"}
- **Approach:** ${notes.approach ?? "N/A"}
- **Risk Factors:** ${(notes.riskFactors ?? []).join(", ") || "None"}

${buildScopeCompliance()}

## Your Task

Research this vulnerability thoroughly and produce a complete submission-ready report. You have internet access to investigate the target asset.

**Requirements:**
1. Verify the vulnerability is ACTUALLY exploitable at runtime — not just theoretically vulnerable in source code
2. Include a working Proof of Concept with ACTUAL output (copy-paste real output, do not paraphrase)
3. Write clear Steps to Reproduce that a triager can follow immediately
4. Assess realistic impact — what could an attacker ACTUALLY achieve? Only state what you demonstrated.
5. **Actively try to disprove the finding** — check if the data is already public, if middleware blocks exploitation, if impact is theoretical. Describe your falsification attempts in the report.

**IMPORTANT:** It is BETTER to output NO_FINDINGS than to submit a weak report. If you cannot fully demonstrate exploitability with captured output, do not report it.

If investigation reveals this vulnerability cannot actually be exploited or has no meaningful impact, output this instead:

===NO_FINDINGS===
[Explain what you investigated and why the vulnerability is not exploitable]
===NO_FINDINGS_END===

Your report will be submitted directly to HackerOne. Write it in this exact format. The sections map to HackerOne's submission form fields:

===FINDING_START===
**Title:** [Clear descriptive title]
**Severity:** [critical/high/medium, calibrated to DEMONSTRATED impact:
  critical = Full RCE, auth bypass to admin, mass data exfil you actually demonstrated
  high = Significant proven impact: real data exposure, privilege escalation, account takeover with working PoC
  medium = Real vulnerability with constrained impact: limited exposure, requires interaction, or moderate practical consequences
  When in doubt, go one level LOWER. Overstated severity hurts credibility.]
**Vulnerability Type:** ${finding.vulnerabilityType ?? "[CWE or category]"}
**Target Asset:** ${finding.targetAsset ?? "[specific URL/asset]"}
**Confidence:** [0-1, calibrated STRICTLY:
  0.95-1.0 = Fully exploited at runtime, working PoC with confirmed real-world impact, output captured
  0.8-0.94 = Exploited at runtime but edge cases or impact scope uncertain
  Below ${config.SECURITY_MIN_CONFIDENCE} = Do NOT report, insufficient evidence]

**Falsification Attempts:**
[REQUIRED. For internal review only. Briefly describe what you checked to verify this is real.]

**Vulnerability Information:**
[This is the main body of your HackerOne report.

WRITING STYLE (critical):
- Write like a human security researcher, not a language model. Short, direct sentences. No filler.
- NEVER use em-dashes. Use commas, periods, or parentheses instead.
- Avoid AI tells: "It's important to note", "This means that", "essentially", "furthermore", "notably", "comprehensive", "robust", "facilitate", "leverage", "in order to" (just say "to").
- Don't hedge. "An attacker can X" not "could potentially allow an attacker to possibly X."
- Don't pad sections. One-sentence summary is fine. One-line fix is fine.
- Use plain technical language and contractions. "The parser reads the wrong byte" not "The parser inadvertently processes an incorrect byte offset."

Include these sections:

## Summary
2-3 sentences. What the bug is, where it is, what it does. No preamble.

## Vulnerability Details
Technical explanation with affected code paths, files, line numbers. Explain the root cause.

## Steps to Reproduce
1. Detailed numbered steps with exact commands and their ACTUAL output

## Proof of Concept
Working exploit with ACTUAL captured output. Must demonstrate real impact.

## Remediation
Specific, actionable fix with code examples where helpful.]

**Impact:**
[STANDALONE impact statement for HackerOne's separate Impact field. State what an attacker can actually do based on what you demonstrated. If the impact is limited, say so. Honest assessment of moderate impact is more credible than inflated claims.]
===FINDING_END===

Be thorough, honest, and write like a person. Do not fabricate evidence. Only report vulnerabilities you can prove with reproducible evidence. Reporting NO_FINDINGS is the correct and expected outcome when exploitation cannot be confirmed.`;
}

// ── Result Types ─────────────────────────────────────────────

export interface ParsedFinding {
  title: string;
  severity: string;
  vulnerabilityType: string;
  targetAsset: string;
  confidence: number;
  reportBody: string;
}

export interface SecuritySolveResult {
  success: boolean;
  findings: ParsedFinding[];
  rawOutput: string;
  error?: string;
}

export function parseFindings(output: string): ParsedFinding[] {
  const findings: ParsedFinding[] = [];
  const regex = /===FINDING_START===([\s\S]*?)===FINDING_END===/g;
  let match;

  while ((match = regex.exec(output)) !== null) {
    const block = match[1].trim();

    const title = block.match(/\*\*Title:\*\*\s*(.+)/)?.[1]?.trim() ?? "Untitled Finding";
    const severity = block.match(/\*\*Severity:\*\*\s*(.+)/)?.[1]?.trim().toLowerCase() ?? "medium";
    const vulnType = block.match(/\*\*Vulnerability Type:\*\*\s*(.+)/)?.[1]?.trim() ?? "Unknown";
    const target = block.match(/\*\*Target Asset:\*\*\s*(.+)/)?.[1]?.trim() ?? "Unknown";
    const confMatch = block.match(/\*\*Confidence:\*\*\s*([\d.]+)/);
    let confidence = confMatch ? Math.max(0, Math.min(1, parseFloat(confMatch[1]))) : 0.5;

    // Hard-reject findings without a meaningful PoC — no PoC = no report
    // PoC can appear in multiple formats: **Proof of Concept:** / ## Proof of Concept / **Attack Vectors:** / **Affected Code:**
    const pocSection = block.match(/(?:\*\*Proof of Concept:\*\*|## Proof of Concept)\s*([\s\S]*?)(?=\*\*(?:Remediation|Impact):\*\*|## (?:Remediation|Impact)|===FINDING_END===|$)/)
      ?? block.match(/(?:\*\*Attack Vectors?:\*\*|\*\*Affected Code:\*\*)\s*([\s\S]*?)(?=\*\*(?:Remediation|Impact):\*\*|## (?:Remediation|Impact)|===FINDING_END===|$)/);
    const pocContent = pocSection?.[1]?.trim() ?? "";
    const hasMeaningfulPoc = pocContent.length > 50 && (
      // Web/API attack patterns
      /(?:curl|https?:\/\/|<script|SELECT|payload|exploit|POST|PUT|DELETE)/i.test(pocContent) ||
      // Code-review-based PoCs (source code snippets, diffs, function signatures)
      /(?:```|function\s+\w+|def\s+\w+|func\s+\w+|fn\s+\w+|contract\s+\w+|class\s+\w+|\/\/\s*(?:BUG|CORRECT|Fix|VULN)|return\s+(?:nil|null|err|None)|diff\s+--|---\s+a\/|^\+\s+|^\-\s+)/mi.test(pocContent)
    );
    if (!hasMeaningfulPoc) {
      // No PoC = hard reject. Skip this finding entirely.
      log.info({ title, pocLen: pocContent.length }, "Finding rejected: no meaningful Proof of Concept");
      continue;
    }

    // Hard-reject findings without substantive falsification attempts
    // Also accept **Summary:** sections that contain falsification language (alternate format)
    const falsSection = block.match(/\*\*Falsification Attempts:\*\*\s*([\s\S]*?)(?=\*\*(?:Description|Vulnerability Information):\*\*|$)/)
      ?? block.match(/\*\*(?:Summary|Analysis):\*\*\s*([\s\S]*?)(?=\*\*(?:Affected Code|Attack Vectors?|Proof of Concept|Remediation|Impact):\*\*|## |$)/);
    const falsContent = falsSection?.[1]?.trim() ?? "";
    // Must be substantive — not just "I confirmed it works" or "I verified this is real"
    const hasFalsification = falsContent.length > 80 && (
      /(?:tried|tested|checked|attempted|ruled out|disprove|falsif|does not|doesn't|cannot|blocked|prevents|WAF|middleware|framework|sanitiz|escap|encod|filter|however|but\s|although)/i.test(falsContent)
    );
    if (!hasFalsification) {
      log.info({ title, falsLen: falsContent.length }, "Finding rejected: no substantive falsification attempts");
      continue;
    }

    findings.push({
      title,
      severity: ["critical", "high", "medium", "low", "informational"].includes(severity) ? severity : "medium",
      vulnerabilityType: vulnType,
      targetAsset: target,
      confidence,
      reportBody: block,
    });
  }

  return findings;
}

// ── Public API ───────────────────────────────────────────────

/**
 * Hunt for vulnerabilities in a program's scope.
 * This is the main entry point — no pre-existing finding needed.
 */
/**
 * Compute hunt timeout based on asset types in scope.
 * Source code analysis gets more time since code review is deeper.
 */
function computeHuntTimeoutMs(program: SecurityProgram): number {
  const config = getConfig();
  const scopes = parseScopes(program);
  const { hasSourceCode } = detectAssetTypes(scopes);

  if (hasSourceCode) {
    return config.SECURITY_SOURCE_CODE_TIMEOUT_MINUTES * 60 * 1000;
  }
  return config.SECURITY_HUNT_TIMEOUT_MINUTES * 60 * 1000;
}

/**
 * Detect the primary strategy used for this hunt (for learning context tracking).
 */
export function detectHuntStrategy(program: SecurityProgram): "code_review" | "web_testing" | "api_testing" | "mixed" {
  const scopes = parseScopes(program);
  const { hasSourceCode, hasWebApp, hasApi } = detectAssetTypes(scopes);

  if (hasSourceCode) return "code_review";
  if (hasApi && !hasWebApp) return "api_testing";
  if (hasWebApp && !hasApi) return "web_testing";
  return "mixed";
}

// ── Adversarial Review Prompt ─────────────────────────────────
// A second-opinion review that tries to find reasons a triager would REJECT the finding.

export function buildAdversarialReviewPrompt(
  finding: SecurityFinding,
  program: SecurityProgram,
): string {
  const scopes = parseScopes(program);
  const rewardRange = formatRewardRange(program);

  return `You are a seasoned bug bounty triager and your job is to play devil's advocate. You have been given a vulnerability report that is about to be submitted to a bug bounty program. Your goal is to find every reason this report might be REJECTED, closed as informative, or downgraded.

You are not the researcher — you are the skeptic. Assume the researcher has blind spots. Challenge every claim.

## Program Context
- **Program:** ${program.name}
- **Platform:** ${program.provider}
- **Reward Range:** ${rewardRange}
- **Program Age/Maturity:** ${program.responseEfficiency != null ? `Response efficiency: ${(program.responseEfficiency * 100).toFixed(0)}%` : "unknown"}

## In-Scope Assets
${scopes.slice(0, 20).map((s: any, i: number) => `${i + 1}. [${s.assetType}] ${s.assetIdentifier}`).join("\n") || "No scope information available"}

## The Report Under Review

${finding.reportBody ?? finding.description ?? "No report body available"}

---

## Your Review — Assess Each of These Angles

### 1. Is the exposed data already publicly accessible?
Would a normal user of the application already see this data through intended functionality? Check whether the supposedly leaked information is rendered in HTML, included in client-side JavaScript bundles, returned by public APIs, or documented publicly. If the data is available through normal usage, the report's finding has no additional security impact beyond what is already accessible.

### 2. Does the PoC work in a realistic environment?
Source code analysis alone is not enough. Consider whether infrastructure-level protections (WAFs, reverse proxies, platform middleware, framework-level security defaults, nonce enforcement, CSRF tokens at a higher layer) would prevent exploitation at runtime even though the vulnerable code path exists in source. If the report acknowledges failed live testing or hedges with "confirmed in source code only," that is a significant weakness.

### 3. Is the stated impact realistic?
Does the attack actually achieve what the report claims? Consider whether downstream systems validate, sanitize, rate-limit, or simply ignore the manipulated data. A vulnerability with theoretical impact but no practical consequence will be closed as informative. Check if the impact section makes unsupported leaps from "X is possible" to "Y would happen."

### 4. Duplicate and known-pattern risk
Is this a well-known vulnerability pattern that automated scanners or junior researchers commonly find? On programs that have been active for more than a few months, surface-level findings are almost certainly already reported. Consider: how long has this program been on the platform? How obvious is this finding? Would it survive the 10-minute test (would a junior researcher find this in their first 10 minutes)?

### 5. Scope and severity calibration
Is the affected asset actually listed in scope? Is the severity rating justified by the DEMONSTRATED (not theoretical) impact? Would a triager downgrade the severity based on the actual PoC? Are there mitigating factors the researcher ignored? Apply these severity thresholds strictly:
- critical: requires demonstrated RCE, full auth bypass, or mass data exfiltration
- high: requires demonstrated significant data exposure, privilege escalation, or account takeover
- medium: real bug with constrained practical impact
If the report claims high/critical but the demonstrated impact only supports medium, flag this as a severity issue. Overstated severity is a top reason for report downgrades and credibility loss.

### 6. Writing quality
Does the report read like a human wrote it, or does it have obvious AI tells? Check for: em-dashes everywhere, hedging phrases ("could potentially allow"), filler ("It's important to note", "furthermore", "notably"), and inflated language ("comprehensive", "robust", "facilitates"). These patterns signal AI-generated content to triagers and hurt credibility. Flag specific examples if found.

### The $100 Test (MANDATORY — this gates submission)
Would you bet $100 of your own money that this report gets accepted AND receives a bounty payout? This is not rhetorical — your answer directly determines whether this report gets submitted. If there's any hesitation, the answer is false.

## Output Format

Respond with ONLY a JSON object (no markdown fences, no explanation outside the JSON):

{
  "verdict": "approve" | "reject",
  "recommendation": "submit" | "submit_cautiously" | "dont_submit",
  "bet100": true | false,
  "rubric": {
    "exploitability": 0-3,
    "impactSeverity": 0-3,
    "evidenceQuality": 0-3,
    "novelty": 0-3,
    "scopeAlignment": 0-3
  },
  "issues": [
    {
      "category": "already_public" | "not_exploitable" | "impact_overstated" | "likely_duplicate" | "scope_or_severity" | "signal_required" | "dead_code" | "ai_writing" | "severity_inflated" | "other",
      "severity": "fatal" | "warning" | "info",
      "description": "Specific explanation of the issue"
    }
  ],
  "reasoning": "2-3 sentence overall assessment explaining your verdict and recommendation"
}

The verdict ("approve"/"reject") is about whether the BUG IS REAL. The recommendation ("submit"/"submit_cautiously"/"dont_submit") is about whether we SHOULD SUBMIT IT — these are independent. A real bug in dead code with no callers = approve + dont_submit. A real bug on a signal-requiring program we can't access = approve + dont_submit.

**IMPORTANT:** If bet100 is false, recommendation MUST be "dont_submit" regardless of verdict. We cannot afford to submit reports we aren't confident about — our Signal score is negative and every rejection makes it worse.

## Rubric Scoring Guide

Score each dimension as an integer from 0 to 3:

**exploitability** — How reproducible is the vulnerability?
- 0 = theoretical only, no demonstration possible
- 1 = requires highly unlikely conditions (specific version, race condition, etc.)
- 2 = reproducible with moderate effort and setup
- 3 = trivially reproducible with provided steps

**impactSeverity** — What is the real-world security impact?
- 0 = no meaningful security impact
- 1 = minor/informational (e.g., internal path disclosure)
- 2 = moderate impact (e.g., limited data exposure, privilege escalation with constraints)
- 3 = significant impact (e.g., RCE, auth bypass, mass data exposure)

**evidenceQuality** — How strong is the proof?
- 0 = no proof-of-concept provided
- 1 = partial/theoretical PoC, or "confirmed in source code only" (for web apps with live endpoints)
- 2 = working PoC with some caveats or gaps, OR confirmed through direct source analysis of SDK/library code where no live environment exists for the researcher to test against
- 3 = complete PoC with clear, reproducible output

**novelty** — How likely is this to be a duplicate?
- 0 = almost certainly already reported (obvious finding on mature program)
- 1 = likely known (common pattern, program active > 6 months)
- 2 = possibly novel (non-obvious finding or newer program)
- 3 = clearly novel (creative approach, unique attack path)

**scopeAlignment** — Does this target in-scope assets at appropriate severity?
- 0 = clearly out of scope
- 1 = edge case (questionable scope, or severity drastically overstated)
- 2 = in scope with reasonable severity rating
- 3 = core in-scope asset with well-justified severity

Rules:
- This is a binary decision: is this a real bug, or not?
- "approve" means you believe this is a genuine security flaw that will be accepted and paid
- "reject" means you believe this is wrong, not exploitable, already public, or duplicate
- Any issue with severity "fatal" MUST result in a "reject" verdict
- Score each rubric dimension independently based on the evidence in the report
- Do NOT output an adjustedConfidence field — confidence will be computed from your rubric scores
- Be specific in descriptions — vague concerns like "might be a duplicate" are not useful. Explain WHY.`;
}

/**
 * Prepare the /tmp/security-audit/ workspace before spawning the hunter.
 * Writes a CLAUDE.md with persistent reference material that survives context window scrolling.
 * Also pre-installs semgrep for static analysis.
 */
async function prepareWorkspace(program: SecurityProgram): Promise<void> {
  const workDir = "/tmp/security-audit";
  await rm(workDir, { recursive: true, force: true });
  await mkdir(workDir, { recursive: true });

  const scopes = parseScopes(program);
  const config = getConfig();

  const minConfidence = config.SECURITY_MIN_CONFIDENCE;

  // Minimal CLAUDE.md — stable behavioral context is in system prompt,
  // per-program context is in user message. This file is only a quick-reference
  // card that survives context window scrolling.
  const claudeMd = `# Security Audit Workspace — ${program.name}

**Program:** ${program.name} (${program.provider})
**Reward Range:** ${formatRewardRange(program)}
**Workspace:** /tmp/security-audit/
**Rate limits:** curl 1 req/sec, nmap T3 max, nuclei -rl 10, ffuf -rate 10. HTTP 429 = stop 60s.
**Quality bar:** confidence ≥ ${minConfidence}, severity ≥ medium, runtime PoC required (source code: reachable path sufficient)
**Excluded types:** ${EXCLUDED_VULN_TYPES.join(", ")}

## Tool Cheat Sheet
\`\`\`
# Semgrep (use this first for source code)
semgrep --config=auto /tmp/security-audit/<repo> --json 2>/dev/null | jq '.results[] | {check_id, path, line: .start.line, message: .extra.message}'
semgrep --config=p/owasp-top-ten /tmp/security-audit/<repo>

# Dangerous sinks (grep fallback)
grep -rn "eval\\|exec\\|system\\|popen\\|subprocess\\|child_process" --include="*.py" --include="*.js" --include="*.ts"
grep -rn "innerHTML\\|dangerouslySetInnerHTML\\|v-html\\|html_safe" --include="*.js" --include="*.tsx" --include="*.html"

# Dependencies
npm audit --json 2>/dev/null | jq '.vulnerabilities | to_entries[] | select(.value.severity == "critical" or .value.severity == "high")'
pip3 install pip-audit -q && pip-audit -r requirements.txt --format json

# Nuclei
go install -v github.com/projectdiscovery/nuclei/v3/cmd/nuclei@latest 2>/dev/null
nuclei -u <url> -rl 10 -silent -severity critical,high,medium

# ffuf
go install github.com/ffuf/ffuf/v2@latest 2>/dev/null
curl -sL https://raw.githubusercontent.com/danielmiessler/SecLists/master/Discovery/Web-Content/common.txt > /tmp/wordlist.txt
ffuf -u <url>/FUZZ -w /tmp/wordlist.txt -rate 10 -mc 200,301,302,403 -fs 0
\`\`\`

Use this file to jot down investigation notes that should survive context window scrolling.
`;

  await writeFile(join(workDir, "CLAUDE.md"), claudeMd, "utf-8");

  // Pre-install security tools if not available
  const { execSync } = await import("node:child_process");

  const tools = [
    { name: "semgrep", check: "which semgrep", install: "pip3 install semgrep -q" },
    { name: "nmap", check: "which nmap", install: "brew install nmap 2>/dev/null || apt-get install -y nmap 2>/dev/null" },
  ];

  for (const tool of tools) {
    try {
      execSync(tool.check, { stdio: "ignore" });
    } catch {
      log.info(`${tool.name} not found, installing...`);
      try {
        execSync(tool.install, { stdio: "ignore", timeout: 120_000 });
        log.info(`${tool.name} installed successfully`);
      } catch (err) {
        log.warn({ err }, `Failed to install ${tool.name} — hunter will work without it`);
      }
    }
  }
}

/**
 * Run a tool-enabled adversarial verification that actually executes the PoC
 * to verify claims in the report. This is the second phase of review, after
 * the text-only analysis passes.
 */
export async function spawnAdversarialVerification(
  finding: SecurityFinding,
  program: SecurityProgram,
): Promise<{ verified: boolean; output: string }> {
  const config = getConfig();
  const scopes = parseScopes(program);

  const prompt = `You are a bug bounty triager verifying a vulnerability report. Your ONLY job is to reproduce the PoC and verify it works.

${buildReviewerSystemContext()}

## Program: ${program.name}
## In-Scope Assets
${scopes.slice(0, 20).map((s: any) => `- [${s.assetType}] ${s.assetIdentifier}`).join("\n")}

## Report to Verify

${finding.reportBody ?? finding.description ?? "No report body"}

---

## Your Task

1. Extract the PoC commands from the report (curl commands, scripts, etc.)
2. Run them EXACTLY as described
3. Compare the actual output to what the report claims
4. Check if the claimed impact is real:
   - Is the "leaked" data already publicly available through normal app usage?
   - Does the exploit actually work, or does a WAF/middleware block it?
   - Is the severity rating justified by what you observe?

## Output

Respond with ONLY a JSON object:
{
  "verified": true/false,
  "actualOutput": "What the PoC commands actually returned",
  "matchesClaims": true/false,
  "issues": ["List of discrepancies between report claims and reality"],
  "recommendation": "approve" | "reject" | "needs_revision"
}

If the PoC commands fail, return 404, get blocked by WAF, or produce different output than claimed, set verified=false.
Be honest. A failed verification is a GOOD outcome — it prevents a false positive from being submitted.`;

  const logDir = getLogDir();
  await mkdir(logDir, { recursive: true });
  const logFile = join(logDir, `verify-${finding.id}.log`);
  await writeFile(logFile, `[${new Date().toISOString()}] Adversarial verification for "${finding.title}"\n`, "utf-8");

  try {
    const output = await spawnClaude(prompt, logFile, 10 * 60 * 1000, undefined, { maxTurns: 50 }); // 10 min, 50 turns — just reproducing a PoC
    const result = extractJsonWithKey<{ verified: boolean }>(output, "verified");
    if (result) {
      return { verified: result.verified === true, output };
    }
    log.warn({ findingId: finding.id, outputLength: output.length }, "Could not extract verification JSON from output");
    return { verified: false, output };
  } catch (err: any) {
    log.error({ err, findingId: finding.id }, "Adversarial verification failed");
    return { verified: false, output: err.message ?? String(err) };
  }
}

// ── Comprehensive Review System ──────────────────────────────
// Single tool-enabled review session that replaces the old two-phase
// text-only review + PoC-only verification flow.

export interface ReviewContext {
  workspacePath: string;
  repoCloned: boolean;
  repoPath?: string;
  disclosedReports: Array<{ title: string; severity: string; disclosedAt: string }>;
  policy: string | null;
  requiresSignal: boolean;
  learningContext: string;
  programContext: string;
  batchContext: string;
}

/**
 * Prepare a workspace for the adversarial reviewer with the target repo cloned.
 * Uses /tmp/security-review/ (separate from hunter workspace).
 */
export async function prepareReviewWorkspace(
  finding: SecurityFinding,
  program: SecurityProgram,
): Promise<{ workspacePath: string; repoCloned: boolean; repoPath?: string }> {
  const workDir = "/tmp/security-review";
  await rm(workDir, { recursive: true, force: true });
  await mkdir(workDir, { recursive: true });

  // Extract repo URL from scopes (SOURCE_CODE type) or finding target
  const scopes = parseScopes(program);
  let repoUrl: string | null = null;

  // Check SOURCE_CODE scopes first
  for (const scope of scopes) {
    if (scope.assetType === "SOURCE_CODE" && scope.assetIdentifier) {
      const match = scope.assetIdentifier.match(/https?:\/\/(github\.com|gitlab\.com|bitbucket\.org)\/[^\s]+/);
      if (match) {
        repoUrl = match[0].replace(/\/$/, "");
        break;
      }
    }
  }

  // Fall back to finding's targetAsset
  if (!repoUrl && finding.targetAsset) {
    const match = finding.targetAsset.match(/https?:\/\/(github\.com|gitlab\.com|bitbucket\.org)\/[^\s]+/);
    if (match) repoUrl = match[0].replace(/\/$/, "");
  }

  // Fall back to extracting from report body
  if (!repoUrl && finding.reportBody) {
    const match = finding.reportBody.match(/git clone\s+(https?:\/\/[^\s]+)/);
    if (match) repoUrl = match[1].replace(/\/$/, "");
    if (!repoUrl) {
      const ghMatch = finding.reportBody.match(/https?:\/\/github\.com\/[\w.-]+\/[\w.-]+/);
      if (ghMatch) repoUrl = ghMatch[0].replace(/\/$/, "");
    }
  }

  let repoCloned = false;
  let repoPath: string | undefined;

  if (repoUrl) {
    const repoName = repoUrl.split("/").pop() ?? "repo";
    repoPath = join(workDir, repoName);
    try {
      const { execSync } = await import("node:child_process");
      execSync(`git clone --depth 50 ${repoUrl} ${repoPath}`, {
        timeout: 60_000,
        stdio: "ignore",
      });
      repoCloned = true;
      log.info({ repoUrl, repoPath }, "Cloned target repo for review");
    } catch (err) {
      log.warn({ err, repoUrl }, "Failed to clone target repo for review — proceeding without codebase access");
      repoPath = undefined;
    }
  }

  // Write a CLAUDE.md for the reviewer
  const reviewClaudeMd = `# Security Review Workspace

You are reviewing a vulnerability report for potential submission to HackerOne.
${repoCloned && repoPath ? `\nThe target repository has been cloned to: ${repoPath}\nUse this to verify code-level claims in the report.\n` : ""}
Work within /tmp/security-review/ for any files you create.
`;

  await writeFile(join(workDir, "CLAUDE.md"), reviewClaudeMd, "utf-8");

  return { workspacePath: workDir, repoCloned, repoPath };
}

/**
 * Build the comprehensive adversarial review prompt.
 * This replaces the old text-only buildAdversarialReviewPrompt with a tool-enabled
 * checklist that instructs the reviewer to actively verify each claim.
 */
export function buildComprehensiveReviewPrompt(
  finding: SecurityFinding,
  program: SecurityProgram,
  context: ReviewContext,
): string {
  const scopes = parseScopes(program);
  const rewardRange = formatRewardRange(program);

  // Pre-filter disclosed reports: show relevant ones (matching severity/vuln keywords) + summary of rest
  let disclosedSection = "";
  if (context.disclosedReports.length > 0) {
    const findingVulnType = (finding.vulnerabilityType ?? "").toLowerCase();
    const findingSeverity = (finding.severity ?? "").toLowerCase();
    const findingTitle = (finding.title ?? "").toLowerCase();
    // Extract keywords from finding for relevance matching
    const keywords = [findingVulnType, findingSeverity, ...findingTitle.split(/\s+/).filter(w => w.length > 4)];

    const relevant: typeof context.disclosedReports = [];
    const rest: typeof context.disclosedReports = [];
    for (const r of context.disclosedReports) {
      const titleLower = r.title.toLowerCase();
      const isRelevant = keywords.some(kw => kw && titleLower.includes(kw)) || r.severity === findingSeverity;
      if (isRelevant) relevant.push(r);
      else rest.push(r);
    }

    const MAX_RELEVANT = 30;
    const shownRelevant = relevant.slice(0, MAX_RELEVANT);
    const lines = shownRelevant.map(r =>
      `- [${r.severity}] ${r.title} (${r.disclosedAt ? new Date(r.disclosedAt).toISOString().slice(0, 10) : "?"})`
    ).join("\n");
    const restSummary = rest.length > 0 ? `\n${rest.length} other disclosed reports (different vulnerability types) not shown.` : "";
    disclosedSection = `\n## Previously Disclosed Reports (${context.disclosedReports.length} total, ${shownRelevant.length} potentially relevant)\nCheck for overlap with this finding:\n\n${lines}${restSummary}\n`;
  }

  const signalWarning = context.requiresSignal
    ? `\n**SIGNAL REQUIREMENT:** This program requires a minimum Signal score. We do NOT currently have sufficient Signal. Any submission here risks reputation damage if rejected. Apply the HIGHEST bar.\n`
    : "";

  const policySection = context.policy
    ? `\n## Program Policy\nRead this carefully. Check if the finding violates any exclusions or special rules:\n\n${context.policy.slice(0, 5000)}\n`
    : "";

  const repoInstructions = context.repoCloned && context.repoPath
    ? `\n**Target repo cloned at:** \`${context.repoPath}\`\nYou MUST cd into this repo and verify code-level claims. Do not skip this step.\n`
    : "\nNo target repo available for code verification. Focus on runtime verification via curl/HTTP.\n";

  return `You are a senior bug bounty triager conducting a final review before submission to HackerOne. You have full tool access (bash, curl, git, grep, etc.) and you MUST use them to verify claims. Text-only reasoning is NOT sufficient.

Your job: find every reason this report should NOT be submitted. You are the last line of defense. A false positive damages our Signal score and credibility. Approach this as a skeptic.

## Program Context
- **Program:** ${program.name}
- **Platform:** ${program.provider}
- **Reward Range:** ${rewardRange}
- **Response Efficiency:** ${program.responseEfficiency != null ? `${(program.responseEfficiency * 100).toFixed(0)}%` : "unknown"}
${signalWarning}

## In-Scope Assets
${scopes.slice(0, 20).map((s: any, i: number) => `${i + 1}. [${s.assetType}] ${s.assetIdentifier}`).join("\n") || "No scope information available"}
${repoInstructions}

## The Report Under Review

${finding.reportBody ?? finding.description ?? "No report body available"}

---
${policySection}${disclosedSection}${context.batchContext}
${context.learningContext ? `## Our Track Record\n${context.learningContext}\nIf our acceptance rate is low, apply a HIGHER bar.\n` : ""}
${context.programContext ? `## Program-Specific History\nThis is what we know from previous hunts and submissions on THIS program. Pay close attention to previously rejected/duplicated vuln types.\n\n${context.programContext}\n` : ""}
## YOUR VERIFICATION CHECKLIST

Complete ALL of these tasks. Use bash tools for each one. Do not skip any task.

### Task 1: Scope Verification
- List the program's in-scope assets above
- Verify the finding's target asset matches one of them (exact match or wildcard match)
- If the target is a URL, run \`curl -sI <url>\` to confirm it resolves and belongs to the target organization
- If the target is SOURCE_CODE, confirm the repo exists and is accessible
- FAIL if: target asset doesn't match any in-scope asset

### Task 2: Policy Exclusion Check
- Read the program policy above carefully
- Check if the vulnerability type is explicitly excluded (many programs exclude: information disclosure, missing headers, rate limiting, clickjacking, open redirect, etc.)
- Check for special conditions: testing restrictions, required Signal, authentication requirements
- FAIL if: the finding's vulnerability type or target matches a policy exclusion

### Task 3: Codebase Verification ${context.repoCloned ? "(REQUIRED — repo available)" : "(SKIP if no repo)"}
${context.repoCloned && context.repoPath ? `- \`cd ${context.repoPath}\`
- Verify the vulnerable file/function mentioned in the report exists: \`find . -name "<filename>" -o -path "*<path>*"\`
- Check if the vulnerable code has callers: \`grep -rn "<function_name>" --include="*.ts" --include="*.js" --include="*.py"\` etc.
- Check for mitigations in the code path: sanitization, validation, middleware, WAF config
- Check \`git log --oneline -5 <file>\` to see if the vulnerability was recently patched
- FAIL if: the file/function doesn't exist, has no callers (dead code), or has mitigations the report ignores` : "- No repo cloned. Skip this task."}

### Task 4: PoC Reproduction
- Extract the PoC commands from the report (curl commands, scripts, etc.)
- Run them EXACTLY as described
- Compare the actual output to what the report claims
- Check: is the "leaked" data already publicly available through normal app usage?
- Check: does the exploit actually work, or does a WAF/rate limiter/middleware block it?
- For source code findings without live endpoints: verify the code path is reachable (check if the function is called, if the route is registered, if the config enables it)
- FAIL if: PoC doesn't reproduce, output doesn't match claims, or "leaked" data is already public

### Task 5: Duplicate Detection
- Review ALL disclosed reports listed above
- Check if any disclosed report covers the same vulnerability type on the same target/component
- Check if this is a well-known pattern (e.g., missing CSRF on a specific endpoint) that was likely already reported even if not disclosed
- Consider: how long has this program been active? How obvious is this finding? Would a junior researcher find it in 10 minutes?
- FAIL if: a disclosed report clearly covers the same issue, or this is an obvious finding on a mature program

### Task 6: Impact & Severity Validation
- Does the attack achieve what the report claims?
- Apply these severity thresholds strictly:
  - critical: requires DEMONSTRATED RCE, full auth bypass, or mass data exfiltration
  - high: requires DEMONSTRATED significant data exposure, privilege escalation, or account takeover
  - medium: real bug with constrained practical impact
- If the report claims high/critical but the demonstrated impact only supports medium, this is a severity issue. Set the "correctedSeverity" field in your output to the level that the EVIDENCE actually supports.
- Check if downstream systems validate/sanitize/ignore the manipulated data
- FAIL if: impact is overstated beyond correction, or downstream mitigations neutralize the attack entirely
- If the severity just needs adjustment (e.g., claimed "high" but evidence supports "medium"), set "correctedSeverity" and flag as warning, but don't reject outright

### Task 7: Report Completeness & Falsification Quality
- Does the report have all required HackerOne sections: Summary, Vulnerability Details, Steps to Reproduce, Proof of Concept, Impact?
- Can a triager reproduce the issue from the written steps alone (without guessing)?
- Are PoC outputs actual captured output, not fabricated or "expected" output?
- Is the CVSS/severity justified by the evidence?
- **Check the "Falsification Attempts" section.** The hunter is required to describe how they tried to DISPROVE the finding. Look for:
  - Is the section present? If missing entirely, flag as warning.
  - Is it generic/lazy ("I confirmed the vulnerability works as described")? Flag as warning.
  - Does it describe real disproof attempts (checked mitigations, tested edge cases, verified code path reachability)? That's a positive signal.
  - A weak falsification section means the hunter didn't do adversarial self-review. Apply extra skepticism to all their claims.
- FAIL if: missing sections, unclear reproduction steps, fabricated PoC output, or missing falsification with other warning signs

### Task 8: The $100 Test (MANDATORY — this gates submission)
Would you bet $100 of your own money that this report gets accepted AND receives a bounty payout? This is not rhetorical. Your answer directly determines whether this report gets submitted. If there's any hesitation, the answer is false. Our Signal score is currently negative, so every rejected report makes things worse.

## Output Format

Respond with ONLY a JSON object (no markdown fences, no explanation outside the JSON):

{
  "verdict": "approve" | "reject",
  "recommendation": "submit" | "submit_cautiously" | "dont_submit",
  "bet100": true | false,
  "rubric": {
    "exploitability": 0-3,
    "impactSeverity": 0-3,
    "evidenceQuality": 0-3,
    "novelty": 0-3,
    "scopeAlignment": 0-3
  },
  "issues": [
    {
      "category": "already_public" | "not_exploitable" | "impact_overstated" | "likely_duplicate" | "scope_or_severity" | "signal_required" | "dead_code" | "ai_writing" | "severity_inflated" | "policy_excluded" | "poc_failed" | "other",
      "severity": "fatal" | "warning" | "info",
      "description": "Specific explanation with evidence from your verification"
    }
  ],
  "reasoning": "2-3 sentence overall assessment explaining your verdict and recommendation",
  "correctedSeverity": "critical" | "high" | "medium" | null
}

## Verdict and Recommendation

The verdict ("approve"/"reject") is about whether the BUG IS REAL.
The recommendation ("submit"/"submit_cautiously"/"dont_submit") is about whether we SHOULD SUBMIT IT.
These are independent. A real bug in dead code = approve + dont_submit.

Any issue with severity "fatal" MUST result in verdict "reject" AND recommendation "dont_submit".

**IMPORTANT:** If bet100 is false, recommendation MUST be "dont_submit" regardless of verdict. Our Signal score is negative and every rejection makes it worse. Only submit reports you'd stake money on.

## Rubric Scoring Guide

Score each dimension 0-3:

**exploitability** — 0 = theoretical only, 1 = unlikely conditions, 2 = reproducible with effort, 3 = trivially reproducible
**impactSeverity** — 0 = no impact, 1 = minor/informational, 2 = moderate, 3 = significant (RCE, auth bypass, mass data)
**evidenceQuality** — 0 = no PoC, 1 = theoretical/source-only, 2 = working PoC with caveats, 3 = complete reproducible PoC
**novelty** — 0 = certainly reported, 1 = likely known, 2 = possibly novel, 3 = clearly novel
**scopeAlignment** — 0 = out of scope, 1 = edge case, 2 = in scope with reasonable severity, 3 = core asset with justified severity

CRITICAL: Base your scores on what YOU verified with tools, not what the report claims. If you couldn't verify a claim, score it lower.`;
}

/**
 * Run a comprehensive tool-enabled adversarial review.
 * Replaces the old two-phase text-only + PoC-only flow with a single session
 * that verifies all aspects of the finding.
 */
export async function spawnComprehensiveReview(
  finding: SecurityFinding,
  program: SecurityProgram,
  context: ReviewContext,
): Promise<{ output: string }> {
  const prompt = buildComprehensiveReviewPrompt(finding, program, context);

  const logDir = getLogDir();
  await mkdir(logDir, { recursive: true });
  const logFile = join(logDir, `review-${finding.id}.log`);
  await writeFile(
    logFile,
    `[${new Date().toISOString()}] Comprehensive review for "${finding.title}"\n`,
    "utf-8",
  );

  const config = getConfig();
  const reviewModel = config.REVIEW_MODEL || config.CLAUDE_MODEL;
  const output = await spawnClaude(prompt, logFile, 20 * 60 * 1000, undefined, {
    maxTurns: 100,
    cwd: context.workspacePath,
    systemPrompt: buildReviewerSystemContext(),
    model: reviewModel,
    effort: config.REVIEW_EFFORT,
  });

  return { output };
}

/**
 * Deverbosify a report — remove AI tells from prose while preserving all technical content.
 * Runs as a lightweight Sonnet call with no tools (pure text rewriting).
 * Returns the cleaned report, or the original if the rewrite fails.
 */
export async function deverbosifyReport(reportBody: string): Promise<string> {
  const { runClaude } = await import("@bounty/core");

  const prompt = `Rewrite this HackerOne vulnerability report to remove AI writing patterns. Return ONLY the rewritten report, nothing else.

Rules:
- Replace ALL em-dashes (—) with commas, periods, or parentheses
- Remove filler: "It's important to note", "This means that", "essentially", "furthermore", "notably", "comprehensive", "robust", "facilitate", "leverage" (verb), "in order to" (use "to")
- Remove hedging: "could potentially" → direct statement
- Use contractions: "does not" → "doesn't", "is not" → "isn't"
- Use plain language. Vary sentence length. Short sentences are fine.
- Keep ALL technical content, PoC commands, code snippets, URLs, and output EXACTLY as-is
- Preserve these exact section headers (parser depends on them): **Vulnerability Information:**, **Impact:**, ## Summary, ## Vulnerability Details, ## Steps to Reproduce, ## Proof of Concept, ## Remediation

Report to rewrite:

${reportBody}`;

  try {
    const result = await runClaude(prompt, {
      model: "sonnet",
      maxTokens: 8192,
      timeoutMs: 60_000,
      disableTools: true,
    });
    // Validate that key sections survived
    const hasRequiredSections = result.includes("## Summary") && result.includes("## Steps to Reproduce");
    if (hasRequiredSections && result.length > 100) {
      return result;
    }
    log.warn("Deverbosification result missing required sections, using original");
    return reportBody;
  } catch (err) {
    log.warn({ err }, "Deverbosification failed, using original report");
    return reportBody;
  }
}

export async function runProgramHunt(
  program: SecurityProgram,
  trigger?: "auto" | "manual",
): Promise<SecuritySolveResult> {
  // Prepare workspace with CLAUDE.md and tools before spawning
  await prepareWorkspace(program);

  const huntConfig = getConfig();
  const systemPrompt = buildHunterSystemPrompt(huntConfig.SECURITY_MIN_CONFIDENCE);
  const prompt = await buildProgramHuntPrompt(program);
  const timeoutMs = computeHuntTimeoutMs(program);
  const timeoutMinutes = Math.round(timeoutMs / 60000);

  log.info({ programId: program.id, programName: program.name, timeoutMinutes }, "Starting program hunt");

  const logDir = getLogDir();
  await mkdir(logDir, { recursive: true });
  const logFile = join(logDir, `hunt-${program.id}.log`);
  await writeFile(
    logFile,
    `[${new Date().toISOString()}] Hunt started for program "${program.name}" (${program.provider})\n`,
    "utf-8",
  );
  // Clear events file for fresh run (log file is overwritten above, events should match)
  await writeFile(logFile + ".events.jsonl", "", "utf-8").catch(() => {});

  await writeSecuritySolverStatus({
    active: true,
    trigger,
    programId: program.id,
    programName: program.name,
    stage: "hunting",
    startedAt: new Date().toISOString(),
    timeoutMinutes,
  });

  try {
    const updatePid = async () => {
      const pid = getActiveChildPid();
      if (pid) {
        await writeSecuritySolverStatus({
          active: true, trigger,
          programId: program.id, programName: program.name,
          stage: "hunting",
          startedAt: new Date().toISOString(),
          timeoutMinutes,
          pid,
        });
      }
    };
    setTimeout(updatePid, 500);

    const statusBase = {
      active: true as const, trigger,
      programId: program.id, programName: program.name,
      stage: "hunting" as const,
      startedAt: new Date().toISOString(),
      timeoutMinutes,
    };
    const onMetrics = (metrics: SpawnMetrics) => {
      writeSecuritySolverStatus({
        ...statusBase,
        linesOutput: metrics.linesOutput,
        lastActivity: metrics.lastActivity,
        currentActivity: metrics.currentActivity,
        currentActivityDetail: metrics.currentActivityDetail,
        currentActivityStartedAt: metrics.currentActivityStartedAt,
        toolUseCount: metrics.toolUseCount,
        recentEvents: metrics.recentEvents,
      }).catch(() => {});
    };

    const output = await spawnClaude(prompt, logFile, timeoutMs, onMetrics, { systemPrompt, effort: huntConfig.HUNT_EFFORT });

    // Detect incomplete output: if Claude exited without producing any structured markers,
    // the hunt was broken (e.g., Claude got confused, crashed, or quit early).
    const hasMarkers = output.includes("===FINDING_START===") || output.includes("===NO_FINDINGS===");
    if (!hasMarkers) {
      const warning = `WARNING: Hunt produced no structured output (no ===FINDING_START=== or ===NO_FINDINGS=== markers). Output length: ${output.length} chars. Treating as incomplete.`;
      log.warn({ programId: program.id, outputLength: output.length }, warning);
      await appendFile(logFile, `\n[${new Date().toISOString()}] ${warning}\n`).catch(() => {});
      await clearSecuritySolverStatus();
      return { success: false, findings: [], rawOutput: output, error: "incomplete_output" };
    }

    const findings = parseFindings(output);

    log.info({ programId: program.id, findingsCount: findings.length }, "Program hunt completed");
    await clearSecuritySolverStatus();

    return { success: true, findings, rawOutput: output };
  } catch (err: any) {
    log.error({ err, programId: program.id }, "Program hunt failed");
    await appendFile(logFile, `\n[${new Date().toISOString()}] ERROR: ${err.message}\n`).catch(() => {});
    await clearSecuritySolverStatus();
    return { success: false, findings: [], rawOutput: "", error: err.message ?? String(err) };
  }
}

/**
 * Draft a report for a specific existing finding.
 */
export async function runFindingSolver(
  finding: SecurityFinding,
  program: SecurityProgram,
  trigger?: "auto" | "manual",
): Promise<SecuritySolveResult> {
  const config = getConfig();

  // Ensure workspace is prepared with CLAUDE.md and tools
  await prepareWorkspace(program);

  const prompt = buildFindingReportPrompt(finding, program);
  const timeoutMs = config.SECURITY_HUNT_TIMEOUT_MINUTES * 60 * 1000;

  log.info({ findingId: finding.id, program: program.name }, "Starting finding solver");

  const logDir = getLogDir();
  await mkdir(logDir, { recursive: true });
  const logFile = join(logDir, `sec-${finding.id}.log`);
  await writeFile(
    logFile,
    `[${new Date().toISOString()}] Solver started for finding "${finding.title}" (program: ${program.name})\n`,
    "utf-8",
  );
  // Clear events file for fresh run
  await writeFile(logFile + ".events.jsonl", "", "utf-8").catch(() => {});

  await writeSecuritySolverStatus({
    active: true, trigger,
    findingId: finding.id, programName: program.name,
    findingTitle: finding.title, severity: finding.severity ?? undefined,
    stage: "researching",
    startedAt: new Date().toISOString(),
    timeoutMinutes: config.SECURITY_HUNT_TIMEOUT_MINUTES,
  });

  try {
    const updatePid = async () => {
      const pid = getActiveChildPid();
      if (pid) {
        await writeSecuritySolverStatus({
          active: true, trigger,
          findingId: finding.id, programName: program.name,
          findingTitle: finding.title, severity: finding.severity ?? undefined,
          stage: "drafting",
          startedAt: new Date().toISOString(),
          timeoutMinutes: config.SECURITY_HUNT_TIMEOUT_MINUTES, pid,
        });
      }
    };
    setTimeout(updatePid, 500);

    const statusBase = {
      active: true as const, trigger,
      findingId: finding.id, programName: program.name,
      findingTitle: finding.title, severity: finding.severity ?? undefined,
      stage: "drafting" as const,
      startedAt: new Date().toISOString(),
      timeoutMinutes: config.SECURITY_HUNT_TIMEOUT_MINUTES,
    };
    const onMetrics = (metrics: SpawnMetrics) => {
      writeSecuritySolverStatus({
        ...statusBase,
        linesOutput: metrics.linesOutput,
        lastActivity: metrics.lastActivity,
        currentActivity: metrics.currentActivity,
        currentActivityDetail: metrics.currentActivityDetail,
        currentActivityStartedAt: metrics.currentActivityStartedAt,
        toolUseCount: metrics.toolUseCount,
        recentEvents: metrics.recentEvents,
      }).catch(() => {});
    };

    const solveConfig = getConfig();
    const submissionModel = solveConfig.SUBMISSION_MODEL || solveConfig.CLAUDE_MODEL;
    const output = await spawnClaude(prompt, logFile, timeoutMs, onMetrics, { model: submissionModel, effort: solveConfig.SUBMISSION_EFFORT });
    const findings = parseFindings(output);

    log.info({ findingId: finding.id, parsedFindings: findings.length }, "Finding solver completed");
    await clearSecuritySolverStatus();

    return { success: true, findings, rawOutput: output };
  } catch (err: any) {
    log.error({ err, findingId: finding.id }, "Finding solver failed");
    await appendFile(logFile, `\n[${new Date().toISOString()}] ERROR: ${err.message}\n`).catch(() => {});
    await clearSecuritySolverStatus();
    return { success: false, findings: [], rawOutput: "", error: err.message ?? String(err) };
  }
}
