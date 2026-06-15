CREATE TABLE `accounts` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`type` text NOT NULL,
	`initial_balance` real DEFAULT 0 NOT NULL,
	`currency` text NOT NULL,
	FOREIGN KEY (`currency`) REFERENCES `currencies`(`code`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `bills` (
	`id` text PRIMARY KEY NOT NULL,
	`credit_card_id` text NOT NULL,
	`month` integer NOT NULL,
	`year` integer NOT NULL,
	`close_date` text NOT NULL,
	`due_date` text NOT NULL,
	`status` text NOT NULL,
	FOREIGN KEY (`credit_card_id`) REFERENCES `credit_cards`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `bills_card_month_year` ON `bills` (`credit_card_id`,`month`,`year`);--> statement-breakpoint
CREATE TABLE `categories` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`kind` text NOT NULL,
	`parent_id` text,
	FOREIGN KEY (`parent_id`) REFERENCES `categories`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `credit_cards` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`closing_day` integer NOT NULL,
	`due_day` integer NOT NULL,
	`limit_amount` real,
	`currency` text NOT NULL,
	FOREIGN KEY (`currency`) REFERENCES `currencies`(`code`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `currencies` (
	`code` text PRIMARY KEY NOT NULL,
	`symbol` text NOT NULL,
	`name` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `merchant_category` (
	`merchant_key` text NOT NULL,
	`category_id` text NOT NULL,
	`weight` real DEFAULT 1 NOT NULL,
	`origin` text NOT NULL,
	`last_seen` integer,
	PRIMARY KEY(`merchant_key`, `category_id`),
	FOREIGN KEY (`merchant_key`) REFERENCES `merchants`(`key`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`category_id`) REFERENCES `categories`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `merchants` (
	`key` text PRIMARY KEY NOT NULL
);
--> statement-breakpoint
CREATE TABLE `recurring_rules` (
	`id` text PRIMARY KEY NOT NULL,
	`description` text NOT NULL,
	`amount` real NOT NULL,
	`type` text NOT NULL,
	`period` text NOT NULL,
	`next_due` text NOT NULL,
	`currency` text NOT NULL,
	`account_id` text,
	`category_id` text,
	FOREIGN KEY (`currency`) REFERENCES `currencies`(`code`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`category_id`) REFERENCES `categories`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `tags` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `tags_name_unique` ON `tags` (`name`);--> statement-breakpoint
CREATE TABLE `transaction_tags` (
	`transaction_id` text NOT NULL,
	`tag_id` text NOT NULL,
	PRIMARY KEY(`transaction_id`, `tag_id`),
	FOREIGN KEY (`transaction_id`) REFERENCES `transactions`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`tag_id`) REFERENCES `tags`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `transactions` (
	`id` text PRIMARY KEY NOT NULL,
	`description` text NOT NULL,
	`amount` real NOT NULL,
	`type` text NOT NULL,
	`date` text NOT NULL,
	`currency` text NOT NULL,
	`source` text NOT NULL,
	`idempotency_key` text NOT NULL,
	`classification_method` text NOT NULL,
	`confidence` real NOT NULL,
	`raw_input` text,
	`from_account_id` text,
	`to_account_id` text,
	`credit_card_id` text,
	`category_id` text,
	`subcategory_id` text,
	`merchant_key` text,
	`bill_id` text,
	FOREIGN KEY (`currency`) REFERENCES `currencies`(`code`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`from_account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`to_account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`credit_card_id`) REFERENCES `credit_cards`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`category_id`) REFERENCES `categories`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`subcategory_id`) REFERENCES `categories`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`merchant_key`) REFERENCES `merchants`(`key`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`bill_id`) REFERENCES `bills`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "subcategory_requires_category" CHECK("transactions"."subcategory_id" IS NULL OR "transactions"."category_id" IS NOT NULL)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `transactions_idempotency_key_unique` ON `transactions` (`idempotency_key`);--> statement-breakpoint
CREATE INDEX `idx_transactions_date` ON `transactions` (`date`);--> statement-breakpoint
CREATE INDEX `idx_transactions_from_account` ON `transactions` (`from_account_id`);--> statement-breakpoint
CREATE INDEX `idx_transactions_to_account` ON `transactions` (`to_account_id`);--> statement-breakpoint
CREATE INDEX `idx_transactions_category` ON `transactions` (`category_id`);