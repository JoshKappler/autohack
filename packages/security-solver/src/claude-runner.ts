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
} from "@algora/core";
import { writeSecuritySolverStatus, clearSecuritySolverStatus } from "./status";

const log = createLogger("security-claude-runner");

// Track the active child process so it can be killed from outside
let activeChild: ReturnType<typeof spawn> | null = null;

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
    if (event.type === "assistant" && event.message?.content) {
      const texts = event.message.content
        .filter((c: any) => c.type === "text")
        .map((c: any) => c.text);
      return texts.length > 0 ? texts.join("") + "\n" : "";
    }
    if (event.type === "tool_use") {
      const cmd = event.input?.command ?? JSON.stringify(event.input ?? {}).slice(0, 300);
      return `\n> ${event.name}: ${cmd}\n`;
    }
    if (event.type === "tool_result") {
      const text = typeof event.content === "string"
        ? event.content
        : Array.isArray(event.content)
          ? event.content.map((c: any) => c.text ?? "").join("")
          : JSON.stringify(event.content ?? "");
      const trimmed = text.length > 3000 ? text.slice(0, 3000) + "\n[truncated]\n" : text;
      return trimmed + "\n";
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

async function spawnClaude(
  prompt: string,
  logFile: string,
  timeoutMs: number,
  onMetrics?: (metrics: { linesOutput: number; lastActivity: string }) => void,
): Promise<string> {
  // Use PTY runner for rich terminal output (opt-in via SECURITY_LIVE_OUTPUT=1)
  const usePty = process.env.SECURITY_LIVE_OUTPUT === "1";
  log.info({ isTTY: process.stdout.isTTY, usePty }, "spawnClaude: selecting output mode");
  if (usePty) {
    const { spawnClaudeWithPty } = await import(/* webpackIgnore: true */ "./pty-runner.js");
    return spawnClaudeWithPty(prompt, logFile, timeoutMs, onMetrics);
  }

  const config = getConfig();

  return new Promise<string>((resolvePromise, reject) => {
    const claudePath = process.env.CLAUDE_PATH || "claude";
    const child = spawn(
      claudePath,
      [
        "--output-format", "stream-json",
        "--verbose",
        "--dangerously-skip-permissions",
        "--model",
        config.CLAUDE_MODEL,
        "--max-turns", "500",
        "--effort", "high",
        "-",
      ],
      {
        cwd: "/tmp/security-audit",
        env: getClaudeEnv(),
        stdio: ["pipe", "pipe", "pipe"],
      },
    );

    activeChild = child;

    child.stdin.write(prompt);
    child.stdin.end();

    let textOutput = ""; // Accumulated text for parseFindings
    let linesOutput = 0;
    let chunksSinceMetrics = 0;
    let lineBuf = ""; // Buffer for incomplete JSON lines

    const onStdout = async (chunk: Buffer) => {
      const raw = chunk.toString();
      lineBuf += raw;

      // Process complete lines (stream-json emits one JSON object per line)
      const lines = lineBuf.split("\n");
      lineBuf = lines.pop() ?? ""; // Keep incomplete last line in buffer

      for (const line of lines) {
        if (!line.trim()) continue;
        const formatted = formatStreamEvent(line);
        if (formatted) {
          linesOutput++;
          chunksSinceMetrics++;
          try { await appendFile(logFile, formatted); } catch {}
        }
        // Accumulate text content for parseFindings
        const textContent = extractTextContent(line);
        if (textContent) textOutput += textContent;
      }

      if (onMetrics && chunksSinceMetrics >= 5) {
        chunksSinceMetrics = 0;
        onMetrics({ linesOutput, lastActivity: new Date().toISOString() });
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
      reject(new Error(`Security solver timed out after ${Math.round(timeoutMs / 60000)} minutes`));
    }, timeoutMs);

    child.on("error", (err) => {
      clearTimeout(timer);
      activeChild = null;
      reject(err);
    });

    child.on("close", async (code) => {
      clearTimeout(timer);
      activeChild = null;
      await appendFile(logFile, `\n[${new Date().toISOString()}] Process exited with code ${code}\n`).catch(() => {});
      if (code === 0) {
        resolvePromise(textOutput);
      } else {
        reject(new Error(`Claude CLI exited with code ${code}`));
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
- Phase 1 (recon): ~30 turns
- Phase 2 (deep investigation): ~350 turns
- Phase 3 (adversarial self-review): ~80 turns
- Phase 4 (report writing): ~40 turns

Work within \`/tmp/security-audit/\` for any files you clone or create.`;
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
    blocks.push(`### Source Code Analysis Strategy (HIGHEST PRIORITY)
This program has source code in scope. This is your highest-value target — deep code review finds bugs that surface-level scanning misses.

1. **Clone the repository:** \`git clone <url> /tmp/security-audit/<repo-name>\`
2. **Understand the codebase:** Read README, package manifests (package.json, requirements.txt, go.mod, Gemfile), and directory structure
3. **Identify framework and language**, then focus on framework-specific vulnerability patterns:
   - **Node.js/Express:** prototype pollution, path traversal in static file serving, NoSQL injection, insecure deserialization, regex DoS (ReDoS), template injection
   - **Python/Django/Flask:** SSTI (template injection), pickle deserialization, SQL injection in raw queries, SSRF via user-controlled URLs, command injection via os.system/subprocess
   - **Ruby/Rails:** mass assignment, SQL injection in where/find_by, deserialization via YAML.load/Marshal.load, command injection via backticks/system
   - **Go:** integer overflow, race conditions (missing mutex), path traversal via filepath.Join with user input, SSRF
   - **PHP:** type juggling (== vs ===), file inclusion (LFI/RFI), deserialization via unserialize(), command injection
   - **Java/Spring:** SpEL injection, deserialization, XXE, JNDI injection
4. **Search for security-critical code patterns:**
   - Command injection sinks: \`grep -rn "eval\\|exec\\|system\\|popen\\|subprocess\\|child_process" --include="*.py" --include="*.js" --include="*.ts" --include="*.rb" --include="*.php"\`
   - XSS sinks: \`grep -rn "innerHTML\\|dangerouslySetInnerHTML\\|v-html\\|\\|safe\\|raw\\|html_safe" --include="*.js" --include="*.ts" --include="*.jsx" --include="*.tsx" --include="*.html" --include="*.rb"\`
   - SQL injection: \`grep -rn "query\\|execute\\|raw(\\|\\$\\{.*\\}.*SELECT\\|\\$\\{.*\\}.*INSERT\\|f\\".*SELECT\\|f\\".*INSERT" --include="*.py" --include="*.js" --include="*.ts" --include="*.rb" --include="*.go"\`
   - Hardcoded secrets: \`grep -rn "password\\s*=\\s*['\\"]\|secret\\s*=\\s*['\\"]\|api_key\\s*=\\s*['\\"]\|token\\s*=\\s*['\\"]\|AWS_" --include="*.py" --include="*.js" --include="*.ts" --include="*.env" --include="*.yml" --include="*.yaml"\`
   - Deserialization: \`grep -rn "pickle\\.load\\|yaml\\.load\\|Marshal\\.load\\|unserialize\\|JSON\\.parse.*eval\\|readObject" --include="*.py" --include="*.rb" --include="*.php" --include="*.java"\`
   - File operations: \`grep -rn "readFile\\|writeFile\\|open(\\|fopen\\|file_get_contents\\|send_file\\|sendFile" --include="*.py" --include="*.js" --include="*.ts" --include="*.rb" --include="*.php"\`
   - Redirect sinks: \`grep -rn "redirect\\|Location:\\|res\\.redirect\\|header.*Location\\|HttpResponseRedirect" --include="*.py" --include="*.js" --include="*.ts" --include="*.rb" --include="*.php"\`
5. **Trace user input from entry points** (HTTP route handlers, CLI argument parsers, file upload handlers) through to dangerous sinks — this is where real vulnerabilities live
6. **Check authentication and authorization logic** for bypasses: missing auth middleware on routes, broken role checks, JWT misvalidation, timing attacks
7. **Run Semgrep for deep static analysis** (far more powerful than grep — understands data flow and taint tracking):
   - Full security scan: \`semgrep --config=auto /tmp/security-audit/<repo> --json 2>/dev/null | jq '.results[] | {check_id, path, line: .start.line, message: .extra.message}'\`
   - OWASP Top 10: \`semgrep --config=p/owasp-top-ten /tmp/security-audit/<repo>\`
   - Framework-specific: \`semgrep --config=p/django\`, \`semgrep --config=p/express\`, \`semgrep --config=p/flask\`, \`semgrep --config=p/rails\`
   - Focus on HIGH and ERROR severity findings — these have the strongest signal for real vulnerabilities
   - Semgrep taint tracking can trace user input through function calls to dangerous sinks, which grep cannot do
8. **Use git history for vulnerability context:**
   - Recent security-relevant changes: \`git log --oneline -30 --all --grep="security\\|fix\\|vuln\\|CVE\\|patch\\|auth\\|sanitize\\|escape\\|inject"\`
   - Check for incomplete security fixes: \`git log -p --follow -- <security-critical-file>\` — recent patches may have edge cases the developer missed
   - \`git blame <file>\` on vulnerable lines to understand when/why they were written
   - Look for reverted security patches or TODOs near security code — these are goldmines
9. **Check dependencies for known CVEs:**
   - Node.js: \`cd /tmp/security-audit/<repo> && npm audit --json 2>/dev/null | jq '.vulnerabilities | to_entries[] | select(.value.severity == "critical" or .value.severity == "high") | {name: .key, severity: .value.severity, via: .value.via[0]}'\`
   - Python: \`pip3 install pip-audit -q && pip-audit -r /tmp/security-audit/<repo>/requirements.txt --format json 2>/dev/null\`
   - Go: check \`go.sum\` versions against \`curl -s "https://services.nvd.nist.gov/rest/json/cves/2.0?keywordSearch=<package>&resultsPerPage=3"\`
   - Focus on CVEs where the vulnerable code path is reachable from the application's entry points — a CVE in a dependency that's never called is not a finding`);
  }

  if (hasWebApp) {
    blocks.push(`### Web Application Strategy
1. **Reconnaissance:**
   - \`curl -sI <url>\` to get response headers and identify tech stack (Server, X-Powered-By, Set-Cookie names)
   - Check for: \`/robots.txt\`, \`/sitemap.xml\`, \`/.well-known/security.txt\`, \`/.env\`, \`/.git/config\`, \`/graphql\`
   - Identify the framework from headers, cookie names, and HTML source
2. **Authentication surface:**
   - Find login, signup, and password reset pages
   - Test for username enumeration (different error messages for valid vs invalid users)
   - Check password reset flow for token predictability or leakage
   - Test for authentication bypass on protected endpoints
3. **Parameter testing** (for each form/endpoint you find):
   - Reflected XSS: inject \`"><img src=x onerror=alert(1)>\` in parameters and check if it's reflected unescaped
   - SQL injection: inject \`' OR '1'='1\` and \`' UNION SELECT NULL--\` and observe response differences
   - IDOR: change numeric/UUID IDs in URLs and API calls to access other users' data
   - Open redirect: inject \`//evil.com\` or \`https://evil.com\` in redirect/callback/next/url parameters
   - Path traversal: inject \`../../../etc/passwd\` in file path parameters
4. **API endpoint discovery:**
   - View JavaScript bundle source for API endpoints and fetch calls
   - Look for GraphQL endpoints (\`/graphql\`, \`/api/graphql\`) — test introspection with \`{__schema{types{name}}}\`
   - Test CORS: \`curl -sI -H "Origin: https://evil.com" <url>\` and check Access-Control-Allow-Origin
5. **Session management:**
   - Check cookie flags (HttpOnly, Secure, SameSite)
   - Test for session fixation
   - Check for CSRF tokens on state-changing actions`);
  }

  if (hasApi) {
    blocks.push(`### API Testing Strategy
1. **Find documentation:** Check \`/docs\`, \`/swagger\`, \`/swagger-ui\`, \`/api-docs\`, \`/openapi.json\`, \`/openapi.yaml\`, \`/.well-known/openapi\`, \`/redoc\`
2. **Enumerate endpoints** from documentation, JavaScript bundles, or by pattern guessing
3. **Test authentication:** Access endpoints without auth headers, with expired/malformed tokens
4. **Test authorization (IDOR):** Access other users' resources by changing IDs in paths and query params
5. **Test input validation:** Send unexpected types (string where int expected), oversized payloads, negative numbers, special characters, null bytes
6. **Mass assignment:** Send extra fields in POST/PUT/PATCH requests (e.g., add \`"role":"admin"\` or \`"isAdmin":true\`)
7. **SSRF:** Submit URLs in parameters that point to internal services (\`http://169.254.169.254/latest/meta-data/\`, \`http://localhost\`, \`http://127.0.0.1\`)
8. **Rate limiting:** Check if critical endpoints (login, password reset, API keys) have rate limiting`);
  }

  if (hasDomain) {
    blocks.push(`### Domain Testing Strategy
1. **DNS enumeration:** \`dig +short <domain> A\`, \`dig +short <domain> CNAME\`, \`dig <domain> TXT\`, \`dig <domain> MX\`, \`dig <domain> NS\`
2. **Subdomain takeover:** Look for CNAME records pointing to decommissioned services (S3 buckets, Heroku apps, GitHub Pages, Azure, etc.). Verify the CNAME target returns an error/default page.
3. **SSL certificate:** \`echo | openssl s_client -connect <host>:443 2>/dev/null | openssl x509 -text -noout\` — check for SANs, expiration, weak ciphers
4. **Email security:** Check SPF (\`dig TXT <domain> | grep spf\`), DKIM, DMARC (\`dig TXT _dmarc.<domain>\`) records
5. **Zone transfer:** \`dig AXFR <domain> @<nameserver>\` (usually blocked, but worth checking)`);
  }

  if (blocks.length === 0) {
    blocks.push(`### General Strategy
Investigate all in-scope assets systematically. Start with web-accessible targets, then check domains for misconfiguration.`);
  }

  return blocks.join("\n\n");
}

// ── Tool Usage Guidance ──────────────────────────────────────

function buildToolGuidance(): string {
  return `## Tools and Techniques

### HTTP requests (use curl for security testing)
- Headers only: \`curl -sI <url>\`
- Full response: \`curl -s <url>\`
- Follow redirects: \`curl -sL <url>\`
- Custom headers: \`curl -s -H "Origin: https://evil.com" -H "X-Forwarded-For: 127.0.0.1" <url>\`
- POST data: \`curl -s -X POST -H "Content-Type: application/json" -d '{"key":"value"}' <url>\`
- With cookies: \`curl -s -b "session=abc123" <url>\`
- Verbose (debug): \`curl -sv <url> 2>&1\`

### DNS
- A record: \`dig +short <domain> A\`
- CNAME: \`dig +short <domain> CNAME\`
- All: \`dig <domain> ANY\`

### Source code
- Clone: \`git clone <url> /tmp/security-audit/<name>\`
- Search: \`grep -rn "pattern" /tmp/security-audit/<name> --include="*.py"\`
- Find config: \`find /tmp/security-audit/<name> -name "*.config" -o -name "*.env" -o -name "*.yml"\`

### Static analysis (Semgrep — use this for source code targets)
- Quick security scan: \`semgrep --config=auto /tmp/security-audit/<repo>\`
- OWASP scan: \`semgrep --config=p/owasp-top-ten /tmp/security-audit/<repo>\`
- Specific rules: \`semgrep --config=p/security-audit /tmp/security-audit/<repo>\`
- JSON output for filtering: \`semgrep --config=auto --json /tmp/security-audit/<repo> 2>/dev/null | jq '.results[] | select(.extra.severity == "ERROR" or .extra.severity == "WARNING")'\`

### SSL/TLS
- Check cert: \`echo | openssl s_client -connect <host>:443 2>/dev/null | openssl x509 -text -noout\`

### JSON processing
- Extract fields: \`curl -s <url> | jq '.data.items[] | {id, name, email}'\`
- JWT decode: \`echo "<token>" | cut -d. -f2 | base64 -d 2>/dev/null | jq .\`

### Port scanning and service detection (nmap)
- Quick scan: \`nmap -sV -T3 --top-ports 100 <host>\`
- Full scan: \`nmap -sV -T3 -p- <host>\` (use only if quick scan suggests interesting services)
- Never use -T4 or -T5 (too aggressive). Stick to T3 or lower.

### Vulnerability scanning (nuclei)
- Install: \`go install -v github.com/projectdiscovery/nuclei/v3/cmd/nuclei@latest 2>/dev/null || pip3 install nuclei -q\`
- CVE scan: \`nuclei -u <url> -t cves/ -rl 10 -silent\`
- Full scan: \`nuclei -u <url> -rl 10 -silent -severity critical,high,medium\`
- Rate limit flag \`-rl 10\` = max 10 requests/second (mandatory)

### Directory discovery (ffuf)
- Install: \`go install github.com/ffuf/ffuf/v2@latest 2>/dev/null\`
- Basic: \`ffuf -u <url>/FUZZ -w /tmp/wordlist.txt -rate 10 -mc 200,301,302,403 -fs 0\`
- Generate wordlist: \`curl -sL https://raw.githubusercontent.com/danielmiessler/SecLists/master/Discovery/Web-Content/common.txt > /tmp/wordlist.txt\`
- API discovery: \`ffuf -u <url>/FUZZ -w /tmp/wordlist.txt -rate 10 -mc 200 -H "Content-Type: application/json"\`

### Web server scanning (nikto)
- Basic: \`nikto -h <url> -Tuning 1 2 3\`
- Install: \`pip3 install nikto -q 2>/dev/null || apt-get install -y nikto 2>/dev/null\`

### STRICTLY FORBIDDEN:
- Brute force attacks (password guessing, credential stuffing)
- Denial of service or resource exhaustion testing
- Social engineering
- Any testing against out-of-scope assets
- sqlmap against production databases without explicit program permission

### Rate limiting (MANDATORY):
- curl: Add \`sleep 1\` between requests to the same host
- nmap: Use -T3 or lower (never -T4/-T5)
- nuclei: Always use \`-rl 10\` (10 requests/sec max)
- ffuf: Always use \`-rate 10\` (10 requests/sec max)
- If you receive HTTP 429, stop that host for 60 seconds
- If endpoints return 500s, back off immediately — do not keep hammering
- Total budget: ~500 requests per host per session. Be surgical, not exhaustive.`;
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

// ── Program Hunt Prompt ──────────────────────────────────────
// This is the main prompt for hunting vulnerabilities in a program.
// No pre-existing finding needed — Opus investigates the program's scope from scratch.

async function buildProgramHuntPrompt(program: SecurityProgram): Promise<string> {
  const scopes = parseScopes(program);
  const assessment = parseAssessment(program);
  const rewardRange = formatRewardRange(program);
  const learningContext = await getSecurityLearningContext();
  const programContext = await getSecurityProgramContext(program.id);

  // Extract policy text if stored in scopeSummary
  let policySection = "";
  try {
    const parsed = JSON.parse(program.scopeSummary || "{}");
    if (parsed.policy) {
      policySection = `\n## Program Policy\nThe following is the program's official policy. You MUST respect any exclusions or special rules listed here:\n\n${String(parsed.policy).slice(0, 3000)}\n`;
    }
  } catch {}

  // Extract disclosed reports if stored
  let disclosedSection = "";
  try {
    const parsed = JSON.parse(program.scopeSummary || "{}");
    if (parsed.disclosedReports && parsed.disclosedReports.length > 0) {
      const reports = parsed.disclosedReports.slice(0, 20);
      disclosedSection = `\n## Known Disclosed Vulnerabilities (already reported — DO NOT duplicate)\n${reports.map((r: any) => `- "${r.title}" (${r.severity ?? "?"}, ${r.disclosedAt ?? "?"})`).join("\n")}\n\nDo NOT report anything that matches or closely resembles these.\n`;
    }
  } catch {}

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

  return `You are an expert bug bounty hunter conducting authorized security testing. Your job is to find REAL, REPRODUCIBLE vulnerabilities in a bug bounty program's in-scope assets and produce professional submission-ready reports.

${buildSystemContext()}

## Program: ${program.name}
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
${buildScopeCompliance()}

${buildToolGuidance()}

## Methodology — Follow These Phases In Order

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

### Phase 3: Adversarial Self-Review — MANDATORY (~25 minutes)
This is the most important phase. For EACH candidate finding, you must actively try to DISPROVE it before reporting. Most candidate findings are false positives — your job here is to kill weak findings before they waste a triager's time.

For each candidate finding, work through this falsification protocol:

**Step A — Challenge the attack path:**
- Is the vulnerable code path actually reachable? Trace the full call chain from user input to the sink. If any middleware, framework default, or deployment config blocks it, the finding is dead.
- For source code findings: Does the live deployment actually use this code path? Check if it's behind a feature flag, deprecated, or overridden by a newer implementation.
- For web findings: Run the actual exploit. Does it work? If your curl command returns an error, gets blocked by a WAF, or doesn't produce the expected output, the finding is dead.

**Step B — Challenge the impact:**
- If the "leaked" data is already visible through normal app usage (rendered in HTML, returned by public APIs, shown in client-side JS), there is no finding. Check this explicitly.
- If the impact requires an unrealistic attack chain (victim must do X, then Y, then Z), downgrade or discard.
- Ask: "What can an attacker ACTUALLY DO with this?" If the honest answer is "not much" or "it depends on unlikely conditions," discard.

**Step C — Challenge the novelty:**
- Would a triager who has seen 10,000 reports immediately recognize this as a common false positive? If yes, discard.
- Is this something an automated scanner would find? If yes on a mature program, it's a duplicate.

**Step D — Reproduce one final time:**
- Run your exact PoC steps again. Does the output match your claims? Copy the actual output — do not paraphrase.
- If the PoC requires authentication you don't have, or a specific environment you can't replicate, the finding is NOT validated.

**Discard anything that fails ANY of Steps A-D. Discard anything with realistic confidence < 0.8.**

It is completely acceptable — even expected — to discard ALL candidate findings at this stage. Reporting zero findings is far better than reporting one false positive.

### Phase 4: Report Writing (final ~10 minutes)
Write only findings that SURVIVED Phase 3. Quality over quantity — one solid finding beats five weak ones. Most hunts should produce zero findings.

${buildValidationChecklist()}

${buildDuplicateAvoidance()}

## Output Format

Your report will be submitted directly to HackerOne. Write it in the exact format below — the sections map to HackerOne's submission form fields. A triager will read this as-is.

For EACH validated vulnerability, output a report block:

===FINDING_START===
**Title:** [Clear, specific descriptive title — not generic like "XSS vulnerability"]
**Severity:** [critical/high/medium — do NOT use low or informational]
**Vulnerability Type:** [CWE ID and name, e.g., "CWE-79: Reflected Cross-Site Scripting"]
**Target Asset:** [The specific URL, endpoint, or file path affected — must match an in-scope asset]
**Confidence:** [0-1, calibrated STRICTLY:
  0.95-1.0 = Fully exploited at runtime, working PoC with confirmed real-world impact, output captured
  0.8-0.94 = Exploited at runtime but edge cases or impact scope uncertain
  0.7-0.79 = Strong evidence and partial PoC, but could not fully demonstrate in live environment
  Below 0.7 = Do NOT report after Phase 3 falsification]

**Falsification Attempts:**
[REQUIRED — for internal review only, not sent to HackerOne. Describe exactly what you did to try to DISPROVE this finding in Phase 3, and why it survived.]

**Vulnerability Information:**
[This is the main body of your HackerOne report. Write it as a complete, well-structured report that a triager can read and act on. Include:

## Summary
2-3 sentence overview of the vulnerability — what it is, where it lives, and why it matters.

## Vulnerability Details
Technical explanation with affected code paths, files, line numbers. Explain the root cause clearly.

## Steps to Reproduce
1. Exact step-by-step reproduction — a triager must be able to follow these
2. Include specific URLs, parameters, headers, payloads
3. Include exact curl commands with their ACTUAL OUTPUT (copy-paste, not paraphrased)

## Proof of Concept
Exact curl commands, code snippets, or tool output that demonstrates the vulnerability. Include ACTUAL command output, not expected output. This is the most important section — weak PoC = rejected report.

## Remediation
Specific, actionable fix recommendation with code examples where possible.]

**Impact:**
[STANDALONE impact statement — this maps to HackerOne's separate "Impact" field. Describe the real-world security consequences: what can an attacker do? What data or systems are affected? What is the business impact? Be specific and realistic — do NOT speculate about worst-case scenarios, state only what you demonstrated or can reasonably conclude from the evidence.]
===FINDING_END===

If you find nothing exploitable after thorough investigation, output:

===NO_FINDINGS===
**Assets Investigated:**
[List what you checked]

**Techniques Applied:**
[What methodologies you used]

**Why No Findings:**
[Honest assessment of why — is the program well-hardened? Were assets unreachable? Scope too narrow for automated testing?]
===NO_FINDINGS_END===

**CRITICAL RULES:**
1. Do NOT fabricate findings. Do NOT speculate. Only report what you can PROVE with reproducible evidence and captured output.
2. A false positive is WORSE than no finding. Every false positive wastes triager time, damages reputation, and reduces the chance of future reports being taken seriously.
3. When in doubt, leave it out. Reporting zero findings is the EXPECTED outcome for most hunts on mature programs.
4. For web/API targets: you must demonstrate exploitability at runtime. For SOURCE_CODE targets: demonstrating the vulnerable code path is reachable in production (via config, deployment manifests, default settings) is sufficient — you do not need to exploit it against the live deployment.
5. If your "exploit" requires conditions you cannot verify (specific server config, internal network access, authenticated session), it is NOT validated — unless you can show the condition is the default or documented configuration.
6. You are expected to discard 80-90% of your candidate findings during Phase 3. If you are not discarding most of them, your bar is too low.
7. Your report will be submitted directly to HackerOne as-is. Write it like a professional security researcher — clear, concise, evidence-based.`;
}

// ── Finding Report Prompt ────────────────────────────────────
// For when we already have a specific finding that needs a full report drafted.

function buildFindingReportPrompt(
  finding: SecurityFinding,
  program: SecurityProgram,
): string {
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

Your report will be submitted directly to HackerOne. Write it in this exact format — the sections map to HackerOne's submission form fields:

===FINDING_START===
**Title:** [Clear descriptive title]
**Severity:** ${finding.severity ?? "[justify the rating]"}
**Vulnerability Type:** ${finding.vulnerabilityType ?? "[CWE or category]"}
**Target Asset:** ${finding.targetAsset ?? "[specific URL/asset]"}
**Confidence:** [0-1, calibrated STRICTLY:
  0.95-1.0 = Fully exploited at runtime, working PoC with confirmed real-world impact, output captured
  0.8-0.94 = Exploited at runtime but edge cases or impact scope uncertain
  Below 0.7 = Do NOT report — insufficient evidence]

**Falsification Attempts:**
[REQUIRED — for internal review only, not sent to HackerOne. What did you do to try to DISPROVE this finding? Why did it survive?]

**Vulnerability Information:**
[This is the main body of your HackerOne report. Write it as a complete, well-structured report:

## Summary
2-3 sentence overview of the vulnerability.

## Vulnerability Details
Technical explanation with affected code paths, files, line numbers. Explain the root cause.

## Steps to Reproduce
1. Detailed numbered steps with exact commands and their ACTUAL output

## Proof of Concept
Working exploit with ACTUAL captured output — must demonstrate real impact.

## Remediation
Specific, actionable fix recommendations with code examples.]

**Impact:**
[STANDALONE impact statement for HackerOne's separate Impact field. What can an attacker do? What data/systems are affected? Be specific and realistic — only state what you demonstrated.]
===FINDING_END===

Be thorough, professional, and honest. Do not fabricate evidence. Only report vulnerabilities you can prove with reproducible evidence. Reporting NO_FINDINGS is the correct and expected outcome when exploitation cannot be confirmed.`;
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

function parseFindings(output: string): ParsedFinding[] {
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

    // Cap confidence if no meaningful PoC is present
    // PoC can appear as **Proof of Concept:** (old format) or ## Proof of Concept (new HackerOne format)
    const pocSection = block.match(/(?:\*\*Proof of Concept:\*\*|## Proof of Concept)\s*([\s\S]*?)(?=\*\*(?:Remediation|Impact):\*\*|## (?:Remediation|Impact)|===FINDING_END===|$)/);
    const pocContent = pocSection?.[1]?.trim() ?? "";
    const hasMeaningfulPoc = pocContent.length > 50 && (
      // Web/API attack patterns
      /(?:curl|https?:\/\/|<script|SELECT|payload|exploit|POST|PUT|DELETE)/i.test(pocContent) ||
      // Code-review-based PoCs (source code snippets, diffs, function signatures)
      /(?:```|function\s+\w+|def\s+\w+|func\s+\w+|fn\s+\w+|contract\s+\w+|class\s+\w+|\/\/\s*(?:BUG|CORRECT|Fix|VULN)|return\s+(?:nil|null|err|None)|diff\s+--|---\s+a\/|^\+\s+|^\-\s+)/mi.test(pocContent)
    );
    if (!hasMeaningfulPoc && confidence > 0.4) {
      confidence = 0.4;
    }

    // Cap confidence if no falsification attempts section (required by prompt)
    const falsSection = block.match(/\*\*Falsification Attempts:\*\*\s*([\s\S]*?)(?=\*\*(?:Description|Vulnerability Information):\*\*|$)/);
    const falsContent = falsSection?.[1]?.trim() ?? "";
    const hasFalsification = falsContent.length > 80; // Must be substantive, not just "I verified it"
    if (!hasFalsification && confidence > 0.6) {
      confidence = 0.6;
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
Is the affected asset actually listed in scope? Is the severity rating justified by the demonstrated (not theoretical) impact? Would a triager downgrade the severity based on the actual PoC? Are there mitigating factors the researcher ignored?

### The $100 Test
Would you bet $100 of your own money that this report gets accepted AND receives a bounty payout? If not, why not?

## Output Format

Respond with ONLY a JSON object (no markdown fences, no explanation outside the JSON):

{
  "verdict": "approve" | "reject",
  "rubric": {
    "exploitability": 0-3,
    "impactSeverity": 0-3,
    "evidenceQuality": 0-3,
    "novelty": 0-3,
    "scopeAlignment": 0-3
  },
  "issues": [
    {
      "category": "already_public" | "not_exploitable" | "impact_overstated" | "likely_duplicate" | "scope_or_severity" | "other",
      "severity": "fatal" | "warning" | "info",
      "description": "Specific explanation of the issue"
    }
  ],
  "reasoning": "2-3 sentence overall assessment explaining your verdict"
}

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

  // Parse program policy if stored
  let policySection = "";
  try {
    const parsed = JSON.parse(program.scopeSummary || "{}");
    if (parsed.policy) {
      policySection = `\n## Program Policy (from ${program.provider})\n${String(parsed.policy).slice(0, 3000)}\n`;
    }
  } catch {}

  const claudeMd = `# Security Audit Workspace — ${program.name}

## Quick Reference

**Program:** ${program.name} (${program.provider})
**Reward Range:** ${formatRewardRange(program)}
**Timeout:** ${config.SECURITY_HUNT_TIMEOUT_MINUTES} minutes / 500 turns

## In-Scope Assets
${scopes.map((s: any, i: number) => `${i + 1}. [${s.assetType}] ${s.assetIdentifier}`).join("\n") || "No scope information"}

## MANDATORY Rules
- ONLY test assets listed above. Violating scope = account ban.
- Rate limit ALL tools: curl (1 req/sec), nmap (T3 max), nuclei (-rl 10), ffuf (-rate 10).
- If you get HTTP 429, stop that host for 60 seconds.
- Do NOT brute force, DoS test, or use sqlmap on production databases.
- Report ZERO findings rather than one false positive.
${policySection}
## Available Tools
- curl, dig, openssl, git, grep, find, jq, python3, node, pip3, base64, xxd, nc
- semgrep (static analysis with taint tracking — superior to grep for code review)
- nmap (port scanning — T3 or lower), nuclei (vuln templates — use -rl 10)
- ffuf (directory discovery — use -rate 10), nikto (web scanning), httpx (HTTP probing)
- Python3 stdlib (JWT decode, base64, hashing, urllib)

## Excluded Vulnerability Types (auto-rejected)
information disclosure, missing security headers, CSP alone, technology fingerprinting,
version disclosure, server header, rate limiting alone, open redirect alone, clickjacking alone, cookie flags alone

## Quality Bar
- Is this a legitimate security flaw? If you are confident the vulnerability is real, report it.
- Confidence must be ≥ 0.65 after self-falsification
- Only critical/high/medium severity — no low/informational
- For web/API targets: runtime PoC required
- For SOURCE_CODE targets: demonstrating the code path is reachable in production is sufficient — you do not need to exploit it against the live deployment
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

${buildSystemContext()}

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
    const output = await spawnClaude(prompt, logFile, 10 * 60 * 1000); // 10 min timeout
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

export async function runProgramHunt(
  program: SecurityProgram,
  trigger?: "auto" | "manual",
): Promise<SecuritySolveResult> {
  // Prepare workspace with CLAUDE.md and tools before spawning
  await prepareWorkspace(program);

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
    const onMetrics = (metrics: { linesOutput: number; lastActivity: string }) => {
      writeSecuritySolverStatus({ ...statusBase, ...metrics }).catch(() => {});
    };

    const output = await spawnClaude(prompt, logFile, timeoutMs, onMetrics);

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
  const prompt = buildFindingReportPrompt(finding, program);
  const timeoutMs = config.SOLVE_TIMEOUT_MINUTES * 60 * 1000;

  log.info({ findingId: finding.id, program: program.name }, "Starting finding solver");

  const logDir = getLogDir();
  await mkdir(logDir, { recursive: true });
  const logFile = join(logDir, `sec-${finding.id}.log`);
  await writeFile(
    logFile,
    `[${new Date().toISOString()}] Solver started for finding "${finding.title}" (program: ${program.name})\n`,
    "utf-8",
  );

  await writeSecuritySolverStatus({
    active: true, trigger,
    findingId: finding.id, programName: program.name,
    findingTitle: finding.title, severity: finding.severity ?? undefined,
    stage: "researching",
    startedAt: new Date().toISOString(),
    timeoutMinutes: config.SOLVE_TIMEOUT_MINUTES,
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
          timeoutMinutes: config.SOLVE_TIMEOUT_MINUTES, pid,
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
      timeoutMinutes: config.SOLVE_TIMEOUT_MINUTES,
    };
    const onMetrics = (metrics: { linesOutput: number; lastActivity: string }) => {
      writeSecuritySolverStatus({ ...statusBase, ...metrics }).catch(() => {});
    };

    const output = await spawnClaude(prompt, logFile, timeoutMs, onMetrics);
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
