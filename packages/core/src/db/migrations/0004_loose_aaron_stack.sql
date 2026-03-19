CREATE TABLE `security_findings` (
	`id` text PRIMARY KEY NOT NULL,
	`program_id` text,
	`title` text NOT NULL,
	`description` text,
	`severity` text,
	`vulnerability_type` text,
	`target_asset` text,
	`status` text DEFAULT 'discovered' NOT NULL,
	`analysis_notes` text,
	`confidence_score` real,
	`report_body` text,
	`report_url` text,
	`report_id` text,
	`rewarded_cents` integer,
	`retry_count` integer DEFAULT 0 NOT NULL,
	`trace_id` text,
	`discovered_at` integer NOT NULL,
	`submitted_at` integer,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`program_id`) REFERENCES `security_programs`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `security_programs` (
	`id` text PRIMARY KEY NOT NULL,
	`provider` text NOT NULL,
	`provider_program_id` text,
	`name` text NOT NULL,
	`url` text,
	`scope_summary` text,
	`reward_min_cents` integer,
	`reward_max_cents` integer,
	`currency` text DEFAULT 'USD',
	`response_efficiency` real,
	`status` text DEFAULT 'active' NOT NULL,
	`discovered_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
