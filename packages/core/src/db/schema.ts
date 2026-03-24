import { sqliteTable, text, integer, real } from "drizzle-orm/sqlite-core";

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
  requiresSignal: integer("requires_signal", { mode: "boolean" }).notNull().default(false),
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
export type SecurityProgram = typeof securityPrograms.$inferSelect;
export type NewSecurityProgram = typeof securityPrograms.$inferInsert;
export type SecurityFinding = typeof securityFindings.$inferSelect;
export type NewSecurityFinding = typeof securityFindings.$inferInsert;
