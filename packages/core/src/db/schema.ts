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
] as const;

export type BountyStatus = (typeof bountyStatuses)[number];

export const bounties = sqliteTable("bounties", {
  id: text("id").primaryKey(),
  algoraUrl: text("algora_url"),
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
  estimatedHours: real("estimated_hours"),
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

// Type helpers
export type Bounty = typeof bounties.$inferSelect;
export type NewBounty = typeof bounties.$inferInsert;
export type PipelineRun = typeof pipelineRuns.$inferSelect;
export type PrReview = typeof prReviews.$inferSelect;
