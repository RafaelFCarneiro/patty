-- ADR-038 §7: an account remembers the cash it held before it held positions; one opening per position, enforced by the database.
ALTER TABLE `accounts` ADD `cash_before_holdings` real;--> statement-breakpoint
CREATE UNIQUE INDEX `investment_events_one_opening` ON `investment_events` (`user_id`,`account_id`,`asset_id`) WHERE "investment_events"."type" = 'opening';