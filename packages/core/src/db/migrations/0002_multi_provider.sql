-- Add multi-provider support columns
ALTER TABLE `bounties` ADD COLUMN `provider` text NOT NULL DEFAULT 'algora';
ALTER TABLE `bounties` ADD COLUMN `provider_bounty_id` text;
ALTER TABLE `bounties` ADD COLUMN `source_url` text;
ALTER TABLE `bounties` ADD COLUMN `payment_guaranteed` integer NOT NULL DEFAULT 1;
--> statement-breakpoint
-- Backfill: copy algora_url to source_url
UPDATE `bounties` SET `source_url` = `algora_url` WHERE `algora_url` IS NOT NULL;
--> statement-breakpoint
-- Backfill: set provider based on ID pattern
UPDATE `bounties` SET `provider` = 'github' WHERE `id` LIKE 'gh-%';
--> statement-breakpoint
-- Backfill: set provider_bounty_id from existing id
UPDATE `bounties` SET `provider_bounty_id` = `id`;
