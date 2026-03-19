ALTER TABLE `security_programs` ADD `hunt_count` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `security_programs` ADD `hunt_miss_streak` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `security_programs` ADD `last_hunted_at` integer;