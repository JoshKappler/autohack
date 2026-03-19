PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_bounties` (
	`id` text PRIMARY KEY NOT NULL,
	`provider` text DEFAULT 'algora' NOT NULL,
	`provider_bounty_id` text,
	`source_url` text,
	`payment_guaranteed` integer DEFAULT true NOT NULL,
	`github_url` text NOT NULL,
	`repo_owner` text NOT NULL,
	`repo_name` text NOT NULL,
	`issue_number` integer NOT NULL,
	`title` text NOT NULL,
	`body` text,
	`labels` text,
	`language` text,
	`reward_cents` integer NOT NULL,
	`currency` text DEFAULT 'USD',
	`status` text DEFAULT 'discovered' NOT NULL,
	`feasibility_score` real,
	`analysis_notes` text,
	`priority_score` real,
	`attempted_at` integer,
	`pr_url` text,
	`pr_number` integer,
	`earned_cents` integer,
	`retry_count` integer DEFAULT 0 NOT NULL,
	`discovered_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
INSERT INTO `__new_bounties`("id", "provider", "provider_bounty_id", "source_url", "payment_guaranteed", "github_url", "repo_owner", "repo_name", "issue_number", "title", "body", "labels", "language", "reward_cents", "currency", "status", "feasibility_score", "analysis_notes", "priority_score", "attempted_at", "pr_url", "pr_number", "earned_cents", "retry_count", "discovered_at", "updated_at") SELECT "id", "provider", "provider_bounty_id", "source_url", "payment_guaranteed", "github_url", "repo_owner", "repo_name", "issue_number", "title", "body", "labels", "language", "reward_cents", "currency", "status", "feasibility_score", "analysis_notes", "priority_score", "attempted_at", "pr_url", "pr_number", "earned_cents", "retry_count", "discovered_at", "updated_at" FROM `bounties`;--> statement-breakpoint
DROP TABLE `bounties`;--> statement-breakpoint
ALTER TABLE `__new_bounties` RENAME TO `bounties`;--> statement-breakpoint
PRAGMA foreign_keys=ON;