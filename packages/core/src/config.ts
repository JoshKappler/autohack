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

  // Discovery
  TARGET_LANGUAGES: z
    .string()
    .default("all")
    .transform((s) => (s === "all" ? [] : s.split(",").map((x) => x.trim()))),
  EXCLUDE_ORGS: commaSplit.default(""),
  EXCLUDE_REPOS: commaSplit.default(""),
  MAX_ISSUE_AGE_DAYS: z.coerce.number().default(30),

  // Analysis
  ANALYSIS_MODEL: z.string().default("haiku"),
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

// Runtime overrides that can be changed without restart (e.g. from dashboard)
const _runtimeOverrides: Partial<Config> = {};

export function loadConfig(): Config {
  if (_config) return _config;
  _config = configSchema.parse(process.env);
  return _config;
}

export function getConfig(): Config {
  const base = _config ?? loadConfig();
  if (Object.keys(_runtimeOverrides).length === 0) return base;
  return { ...base, ..._runtimeOverrides };
}

/** Set a runtime override that takes effect immediately without restart. */
export function setRuntimeOverride<K extends keyof Config>(
  key: K,
  value: Config[K],
): void {
  _runtimeOverrides[key] = value;
}

/** Get current runtime overrides (for dashboard display). */
export function getRuntimeOverrides(): Partial<Config> {
  return { ..._runtimeOverrides };
}
