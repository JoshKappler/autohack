CREATE TABLE `bounties` (
	`id` text PRIMARY KEY NOT NULL,
	`algora_url` text,
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
	`estimated_hours` real,
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
CREATE TABLE `pipeline_runs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`trace_id` text,
	`bounty_id` text,
	`stage` text NOT NULL,
	`status` text NOT NULL,
	`logs` text,
	`error_category` text,
	`error_message` text,
	`started_at` integer NOT NULL,
	`completed_at` integer,
	`duration_ms` integer,
	FOREIGN KEY (`bounty_id`) REFERENCES `bounties`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `pr_reviews` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`bounty_id` text,
	`pr_url` text NOT NULL,
	`comment_id` text NOT NULL,
	`comment_body` text NOT NULL,
	`response_body` text,
	`responded_at` integer,
	FOREIGN KEY (`bounty_id`) REFERENCES `bounties`(`id`) ON UPDATE no action ON DELETE no action
);
