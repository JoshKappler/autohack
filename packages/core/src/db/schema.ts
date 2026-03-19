import { sqliteTable, text, integer, real } from "drizzle-orm/sqlite-core";

export const bountyStatuses = [
  "discovered",
  "analyzing",
  "selected",
  "attempting",
  "solving",
  "pr_created",
  "in_review",
  "merged",
  "rejected",
  "failed",
  "removed",
] as const;

export type BountyStatus = (typeof bountyStatuses)[number];

export const bounties = sqliteTable("bounties", {
  id: text("id").primaryKey(),
  provider: text("provider").notNull().default("algora"),
  providerBountyId: text("provider_bounty_id"),
  sourceUrl: text("source_url"),
  paymentGuaranteed: integer("payment_guaranteed", { mode: "boolean" }).notNull().default(true),
  githubUrl: text("github_url").notNull(),
  repoOwner: text("repo_owner").notNull(),
  repoName: text("repo_name").notNull(),
  issueNumber: integer("issue_number").notNull(),
  title: text("title").notNull(),
  body: text("body"),
  labels: text("labels"), // JSON array
  language: text("language"),
  rewardCents: integer("reward_cents").notNull(),
  currency: text("currency").default("USD"),

  // Pipeline status
  status: text("status", { enum: bountyStatuses })
    .notNull()
    .default("discovered"),

  // Analysis results
  feasibilityScore: real("feasibility_score"),
  analysisNotes: text("analysis_notes"),
  priorityScore: real("priority_score"),

  // Tracking
  attemptedAt: integer("attempted_at", { mode: "timestamp" }),
  prUrl: text("pr_url"),
  prNumber: integer("pr_number"),
  earnedCents: integer("earned_cents"),

  retryCount: integer("retry_count").notNull().default(0),

  discoveredAt: integer("discovered_at", { mode: "timestamp" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp" }).notNull(),
});

export const pipelineRuns = sqliteTable("pipeline_runs", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  traceId: text("trace_id"),
  bountyId: text("bounty_id").references(() => bounties.id),
  stage: text("stage").notNull(),
  status: text("status", {
    enum: ["running", "success", "failed"],
  }).notNull(),
  logs: text("logs"),
  errorCategory: text("error_category"), // transient, permanent, validation, timeout, no_changes
  errorMessage: text("error_message"),
  startedAt: integer("started_at", { mode: "timestamp" }).notNull(),
  completedAt: integer("completed_at", { mode: "timestamp" }),
  durationMs: integer("duration_ms"),
});

export const prReviews = sqliteTable("pr_reviews", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  bountyId: text("bounty_id").references(() => bounties.id),
  prUrl: text("pr_url").notNull(),
  commentId: text("comment_id").notNull(),
  commentBody: text("comment_body").notNull(),
  responseBody: text("response_body"),
  respondedAt: integer("responded_at", { mode: "timestamp" }),
});

// ── Security Bounty Tables ──────────────────────────────

export const securityProgramStatuses = [
  "active",
  "paused",
  "archived",
] as const;

export type SecurityProgramStatus = (typeof securityProgramStatuses)[number];

export const securityPrograms = sqliteTable("security_programs", {
  id: text("id").primaryKey(),
  provider: text("provider").notNull(), // "hackerone" | "bugcrowd"
  providerProgramId: text("provider_program_id"),
  name: text("name").notNull(),
  url: text("url"),
  scopeSummary: text("scope_summary"), // JSON array of in-scope targets
  rewardMinCents: integer("reward_min_cents"),
  rewardMaxCents: integer("reward_max_cents"),
  currency: text("currency").default("USD"),
  responseEfficiency: real("response_efficiency"),
  status: text("status", { enum: securityProgramStatuses })
    .notNull()
    .default("active"),
  launchedAt: integer("launched_at", { mode: "timestamp" }), // when the program started accepting reports
  disclosedReportCount: integer("disclosed_report_count"), // number of publicly disclosed reports (saturation signal)
  huntCount: integer("hunt_count").notNull().default(0),
  huntMissStreak: integer("hunt_miss_streak").notNull().default(0), // consecutive hunts with 0 findings
  lastHuntedAt: integer("last_hunted_at", { mode: "timestamp" }),
  discoveredAt: integer("discovered_at", { mode: "timestamp" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp" }).notNull(),
});

export const securityFindingStatuses = [
  "discovered",
  "scanning",
  "analyzing",
  "validated",
  "drafting",
  "report_ready",
  "reviewing",
  "submitted",
  "triaged",
  "accepted",
  "rewarded",
  "duplicate",
  "not_applicable",
  "informative",
  "failed",
  "dismissed",
  "bot_rejected",
] as const;

export type SecurityFindingStatus = (typeof securityFindingStatuses)[number];

export const securitySeverities = [
  "critical",
  "high",
  "medium",
  "low",
  "informational",
] as const;

export type SecuritySeverity = (typeof securitySeverities)[number];

export const securityFindings = sqliteTable("security_findings", {
  id: text("id").primaryKey(),
  programId: text("program_id").references(() => securityPrograms.id),
  title: text("title").notNull(),
  description: text("description"),
  severity: text("severity", { enum: securitySeverities }),
  vulnerabilityType: text("vulnerability_type"), // CWE or category
  targetAsset: text("target_asset"),
  status: text("status", { enum: securityFindingStatuses })
    .notNull()
    .default("discovered"),
  analysisNotes: text("analysis_notes"), // JSON
  confidenceScore: real("confidence_score"),
  reportBody: text("report_body"),
  reportUrl: text("report_url"),
  reportId: text("report_id"),
  rewardedCents: integer("rewarded_cents"),
  retryCount: integer("retry_count").notNull().default(0),
  traceId: text("trace_id"),
  discoveredAt: integer("discovered_at", { mode: "timestamp" }).notNull(),
  submittedAt: integer("submitted_at", { mode: "timestamp" }),
  updatedAt: integer("updated_at", { mode: "timestamp" }).notNull(),
});

// Type helpers
export type Bounty = typeof bounties.$inferSelect;
export type NewBounty = typeof bounties.$inferInsert;
export type PipelineRun = typeof pipelineRuns.$inferSelect;
export type PrReview = typeof prReviews.$inferSelect;
export type SecurityProgram = typeof securityPrograms.$inferSelect;
export type NewSecurityProgram = typeof securityPrograms.$inferInsert;
export type SecurityFinding = typeof securityFindings.$inferSelect;
export type NewSecurityFinding = typeof securityFindings.$inferInsert;
