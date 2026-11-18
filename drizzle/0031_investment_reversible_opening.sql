-- ADR-038 §7: an opening remembers the cash it replaced; one opening per position, enforced by the database.
ALTER TABLE `investment_events` ADD `replaced_cash` real;--> statement-breakpoint
CREATE UNIQUE INDEX `investment_events_one_opening` ON `investment_events` (`user_id`,`account_id`,`asset_id`) WHERE "investment_events"."type" = 'opening';