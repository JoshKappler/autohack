import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";

const commaSplit = z
  .string()
  .transform((s) => (s ? s.split(",").map((x) => x.trim()) : []));

const configSchema = z.object({
  // Auth
  GITHUB_TOKEN: z.string().min(1),
  ANTHROPIC_API_KEY: z.string().optional().default(""),
  ALGORA_TOKEN: z.string().optional().default(""),

  // Claude backend: "cli" (uses Max subscription) or "api" (uses ANTHROPIC_API_KEY)
  CLAUDE_BACKEND: z.enum(["cli", "api"]).default("cli"),

  // Provider toggles
  ALGORA_ENABLED: z.coerce.boolean().default(true),
  ALGORA_POLL_MINUTES: z.coerce.number().default(5),
  GITHUB_SEARCH_ENABLED: z.coerce.boolean().default(true),
  GITHUB_SEARCH_POLL_MINUTES: z.coerce.number().default(60),

  // Security bounty providers
  HACKERONE_ENABLED: z.coerce.boolean().default(false),
  HACKERONE_POLL_MINUTES: z.coerce.number().default(60),
  HACKERONE_USERNAME: z.string().optional().default(""),
  HACKERONE_API_TOKEN: z.string().optional().default(""),

  // Security solver
  SECURITY_AUTO_HUNT_ENABLED: z.coerce.boolean().default(false),
  SECURITY_HUNT_TIMEOUT_MINUTES: z.coerce.number().default(120),
  SECURITY_SOURCE_CODE_TIMEOUT_MINUTES: z.coerce.number().default(120),
  SECURITY_MIN_CONFIDENCE: z.coerce.number().default(0.65),
  SECURITY_HUNT_COOLDOWN_HOURS: z.coerce.number().default(2),
SECURITY_MIN_REWARD_CENTS: z.coerce.number().default(10000), // $100 minimum to justify 2h Opus
  SECURITY_MAX_DAILY_HUNTS: z.coerce.number().default(12),
  SECURITY_MAX_REVISE_ATTEMPTS: z.coerce.number().default(2), // deprecated — review is now binary approve/reject
  SECURITY_SUBMISSION_POLL_MINUTES: z.coerce.number().default(60),
  EXCLUDE_SECURITY_PROGRAMS: commaSplit.default(""), // comma-separated program handles to skip (e.g. "okg,spotify")

  // Discovery
  TARGET_LANGUAGES: z
    .string()
    .default("all")
    .transform((s) => (s === "all" ? [] : s.split(",").map((x) => x.trim()))),
  EXCLUDE_ORGS: commaSplit.default(""),
  EXCLUDE_REPOS: commaSplit.default(""),
  MAX_ISSUE_AGE_DAYS: z.coerce.number().default(30),

  // Analysis
  ANALYSIS_MODEL: z.string().default("sonnet"),
  MIN_BOUNTY_CENTS: z.coerce.number().default(500), // $5 minimum

  // Solver
  CLAUDE_MODEL: z.string().default("opus"),
  SOLVE_TIMEOUT_MINUTES: z.coerce.number().default(45),
  MAX_TURNS: z.coerce.number().default(100),
  MAX_RETRY_ATTEMPTS: z.coerce.number().default(3),
  MAX_ANALYSIS_RETRIES: z.coerce.number().default(3),

  // Control
  REQUIRE_APPROVAL: z.coerce.boolean().default(true),
  AUTO_RESPOND_REVIEWS: z.coerce.boolean().default(false),
  AUTO_FIX_REVIEWS: z.coerce.boolean().default(false),
  MAX_REVIEW_FIX_ATTEMPTS: z.coerce.number().default(2),
  MAX_CONCURRENT_BOUNTIES: z.coerce.number().default(1),

  // Paths
  WORKSPACE_DIR: z.string().default(".workspaces"),
  DB_PATH: z.string().default("data/algora.db"),

  // Dashboard
  DASHBOARD_PORT: z.coerce.number().default(3456),
});

export type Config = z.infer<typeof configSchema>;

let _config: Config | null = null;

// Runtime overrides that can be changed without restart (e.g. from dashboard).
// Persisted to a shared JSON file so both the orchestrator and dashboard processes see them.
const _runtimeOverrides: Partial<Config> = {};

const OVERRIDES_FILE = join(process.env.PROJECT_ROOT || process.cwd(), "data", "runtime-overrides.json");
let _fileOverridesCache: { data: Partial<Config>; readAt: number } | null = null;
const FILE_CACHE_TTL_MS = 2000;

function readFileOverrides(): Partial<Config> {
  const now = Date.now();
  if (_fileOverridesCache && now - _fileOverridesCache.readAt < FILE_CACHE_TTL_MS) {
    return _fileOverridesCache.data;
  }
  try {
    const raw = readFileSync(OVERRIDES_FILE, "utf-8");
    const data = JSON.parse(raw);
    _fileOverridesCache = { data, readAt: now };
    return data;
  } catch {
    _fileOverridesCache = { data: {}, readAt: now };
    return {};
  }
}

export function loadConfig(): Config {
  if (_config) return _config;
  _config = configSchema.parse(process.env);
  return _config;
}

export function getConfig(): Config {
  const base = _config ?? loadConfig();
  const fileOverrides = readFileOverrides();
  return { ...base, ...fileOverrides, ..._runtimeOverrides };
}

/** Set a runtime override that takes effect immediately without restart.
 *  Persisted to disk so other processes (orchestrator ↔ dashboard) see it too. */
export function setRuntimeOverride<K extends keyof Config>(
  key: K,
  value: Config[K],
): void {
  _runtimeOverrides[key] = value;
  // Persist to shared file for cross-process visibility
  const merged = { ...readFileOverrides(), [key]: value };
  try {
    writeFileSync(OVERRIDES_FILE, JSON.stringify(merged, null, 2));
    _fileOverridesCache = { data: merged, readAt: Date.now() };
  } catch {}
}

/** Get current runtime overrides (for dashboard display). */
export function getRuntimeOverrides(): Partial<Config> {
  return { ...readFileOverrides(), ..._runtimeOverrides };
}
