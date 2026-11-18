-- ADR-038 step 1: shared assets and price history, owned investment events (a position is derived from them, never stored).
CREATE TABLE `asset_prices` (
	`id` text PRIMARY KEY NOT NULL,
	`asset_id` text NOT NULL,
	`price` real NOT NULL,
	`as_of` text NOT NULL,
	`source` text,
	`version` integer DEFAULT 0 NOT NULL,
	FOREIGN KEY (`asset_id`) REFERENCES `assets`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `asset_prices_asset_as_of` ON `asset_prices` (`asset_id`,`as_of`);--> statement-breakpoint
CREATE TABLE `assets` (
	`id` text PRIMARY KEY NOT NULL,
	`symbol` text NOT NULL,
	`exchange` text NOT NULL,
	`name` text NOT NULL,
	`asset_class` text NOT NULL,
	`currency` text NOT NULL,
	`pricing` text NOT NULL,
	`version` integer DEFAULT 0 NOT NULL,
	FOREIGN KEY (`currency`) REFERENCES `currencies`(`code`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `assets_symbol_exchange` ON `assets` (`symbol`,`exchange`);--> statement-breakpoint
CREATE TABLE `investment_events` (
	`id` text PRIMARY KEY NOT NULL,
	`account_id` text NOT NULL,
	`asset_id` text NOT NULL,
	`type` text NOT NULL,
	`date` text NOT NULL,
	`quantity` real NOT NULL,
	`unit_cost` real NOT NULL,
	`idempotency_key` text NOT NULL,
	`note` text,
	`version` integer DEFAULT 0 NOT NULL,
	`user_id` text NOT NULL,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`asset_id`) REFERENCES `assets`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE UNIQUE INDEX `investment_events_user_idempotency_key` ON `investment_events` (`user_id`,`idempotency_key`);--> statement-breakpoint
CREATE INDEX `idx_investment_events_user_account` ON `investment_events` (`user_id`,`account_id`);--> statement-breakpoint
CREATE INDEX `idx_investment_events_asset` ON `investment_events` (`asset_id`);