-- ADR-033 §5/§7 (Phase 4, step 1): tenancy for the data. Every user-owned row gets a user_id; the shared defaults keep it null.
--
-- DATA-REWRITING (listed in diplomat/db/migrations.ts): startup snapshots the database to <db>.pre-0021_tenancy_data.bak
-- and applies this file in the same write transaction, then checks that no owned row lacks a known user.
--
-- Everything that exists today belongs to the owner, inserted by 0018_auth_identity as 'user-owner' (OWNER_USER_ID). The
-- owner is looked up, never assumed: should that row be missing, the NOT NULL below fails and the whole migration rolls back.
--
-- SQLite can neither add a NOT NULL column that references another table nor drop a UNIQUE constraint in place, so each
-- table is rebuilt (create, copy, drop, rename) — with foreign keys OFF, as the migration runner arranges. The guard
-- below refuses to go on otherwise: dropping `transactions` with enforcement on would cascade away `transaction_tags`.
CREATE TABLE `__fk_guard` (`enforcement_is_off` integer NOT NULL);
--> statement-breakpoint
INSERT INTO `__fk_guard` SELECT CASE WHEN `foreign_keys` = 0 THEN 1 END FROM pragma_foreign_keys;
--> statement-breakpoint
DROP TABLE `__fk_guard`;
--> statement-breakpoint
-- Per-user preferences: the owner's row comes from the singleton settings row, if one was ever written.
CREATE TABLE `user_settings` (
	`user_id` text PRIMARY KEY NOT NULL,
	`locale` text DEFAULT 'en' NOT NULL,
	`locale_source` text DEFAULT 'default' NOT NULL,
	`base_currency` text,
	`version` integer DEFAULT 0 NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`base_currency`) REFERENCES `currencies`(`code`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
INSERT INTO `user_settings` (`user_id`, `locale`, `locale_source`, `base_currency`, `version`)
SELECT (SELECT `id` FROM `users` WHERE `id` = 'user-owner'), `locale`, `locale_source`, `base_currency`, `version` FROM `settings` WHERE `id` = 'singleton';
--> statement-breakpoint
CREATE TABLE `__new_settings` (
	`id` text PRIMARY KEY DEFAULT 'singleton' NOT NULL,
	`version` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
INSERT INTO `__new_settings` (`id`, `version`) SELECT `id`, `version` FROM `settings`;
--> statement-breakpoint
DROP TABLE `settings`;
--> statement-breakpoint
ALTER TABLE `__new_settings` RENAME TO `settings`;
--> statement-breakpoint
-- accounts: owned by a user.
CREATE TABLE `__new_accounts` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`type` text NOT NULL,
	`initial_balance` real DEFAULT 0 NOT NULL,
	`currency` text NOT NULL,
	`version` integer DEFAULT 0 NOT NULL,
	`user_id` text NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`currency`) REFERENCES `currencies`(`code`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
INSERT INTO `__new_accounts` (`id`, `name`, `type`, `initial_balance`, `currency`, `version`, `user_id`) SELECT `id`, `name`, `type`, `initial_balance`, `currency`, `version`, (SELECT `id` FROM `users` WHERE `id` = 'user-owner') FROM `accounts`;
--> statement-breakpoint
DROP TABLE `accounts`;
--> statement-breakpoint
ALTER TABLE `__new_accounts` RENAME TO `accounts`;
--> statement-breakpoint
-- credit_cards: owned by a user.
CREATE TABLE `__new_credit_cards` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`closing_day` integer NOT NULL,
	`due_day` integer NOT NULL,
	`limit_amount` real,
	`currency` text NOT NULL,
	`account_id` text NOT NULL,
	`payment_account_id` text,
	`version` integer DEFAULT 0 NOT NULL,
	`user_id` text NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`currency`) REFERENCES `currencies`(`code`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`payment_account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
INSERT INTO `__new_credit_cards` (`id`, `name`, `closing_day`, `due_day`, `limit_amount`, `currency`, `account_id`, `payment_account_id`, `version`, `user_id`) SELECT `id`, `name`, `closing_day`, `due_day`, `limit_amount`, `currency`, `account_id`, `payment_account_id`, `version`, (SELECT `id` FROM `users` WHERE `id` = 'user-owner') FROM `credit_cards`;
--> statement-breakpoint
DROP TABLE `credit_cards`;
--> statement-breakpoint
ALTER TABLE `__new_credit_cards` RENAME TO `credit_cards`;
--> statement-breakpoint
-- bills: owned by a user.
CREATE TABLE `__new_bills` (
	`id` text PRIMARY KEY NOT NULL,
	`credit_card_id` text NOT NULL,
	`month` integer NOT NULL,
	`year` integer NOT NULL,
	`close_date` text NOT NULL,
	`due_date` text NOT NULL,
	`status` text NOT NULL,
	`payment_transaction_id` text,
	`version` integer DEFAULT 0 NOT NULL,
	`user_id` text NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`credit_card_id`) REFERENCES `credit_cards`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`payment_transaction_id`) REFERENCES `transactions`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
INSERT INTO `__new_bills` (`id`, `credit_card_id`, `month`, `year`, `close_date`, `due_date`, `status`, `payment_transaction_id`, `version`, `user_id`) SELECT `id`, `credit_card_id`, `month`, `year`, `close_date`, `due_date`, `status`, `payment_transaction_id`, `version`, (SELECT `id` FROM `users` WHERE `id` = 'user-owner') FROM `bills`;
--> statement-breakpoint
DROP TABLE `bills`;
--> statement-breakpoint
ALTER TABLE `__new_bills` RENAME TO `bills`;
--> statement-breakpoint
CREATE UNIQUE INDEX `bills_card_month_year` ON `bills` (`credit_card_id`,`month`,`year`);
--> statement-breakpoint
-- tags: owned by a user.
CREATE TABLE `__new_tags` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`version` integer DEFAULT 0 NOT NULL,
	`user_id` text NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
INSERT INTO `__new_tags` (`id`, `name`, `version`, `user_id`) SELECT `id`, `name`, `version`, (SELECT `id` FROM `users` WHERE `id` = 'user-owner') FROM `tags`;
--> statement-breakpoint
DROP TABLE `tags`;
--> statement-breakpoint
ALTER TABLE `__new_tags` RENAME TO `tags`;
--> statement-breakpoint
CREATE UNIQUE INDEX `tags_user_name` ON `tags` (`user_id`,`name`);
--> statement-breakpoint
-- budgets: owned by a user.
CREATE TABLE `__new_budgets` (
	`id` text PRIMARY KEY NOT NULL,
	`category_id` text NOT NULL,
	`currency` text NOT NULL,
	`limit_amount` real NOT NULL,
	`period` text DEFAULT 'monthly' NOT NULL,
	`version` integer DEFAULT 0 NOT NULL,
	`user_id` text NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`category_id`) REFERENCES `categories`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`currency`) REFERENCES `currencies`(`code`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
INSERT INTO `__new_budgets` (`id`, `category_id`, `currency`, `limit_amount`, `period`, `version`, `user_id`) SELECT `id`, `category_id`, `currency`, `limit_amount`, `period`, `version`, (SELECT `id` FROM `users` WHERE `id` = 'user-owner') FROM `budgets`;
--> statement-breakpoint
DROP TABLE `budgets`;
--> statement-breakpoint
ALTER TABLE `__new_budgets` RENAME TO `budgets`;
--> statement-breakpoint
CREATE UNIQUE INDEX `budgets_user_category_currency_period` ON `budgets` (`user_id`,`category_id`,`currency`,`period`);
--> statement-breakpoint
-- recurring_rules: owned by a user.
CREATE TABLE `__new_recurring_rules` (
	`id` text PRIMARY KEY NOT NULL,
	`description` text NOT NULL,
	`amount` real NOT NULL,
	`type` text NOT NULL,
	`period` text NOT NULL,
	`next_due` text NOT NULL,
	`currency` text NOT NULL,
	`account_id` text,
	`category_id` text,
	`merchant_key` text,
	`version` integer DEFAULT 0 NOT NULL,
	`user_id` text NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`currency`) REFERENCES `currencies`(`code`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`category_id`) REFERENCES `categories`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`merchant_key`) REFERENCES `merchants`(`key`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
INSERT INTO `__new_recurring_rules` (`id`, `description`, `amount`, `type`, `period`, `next_due`, `currency`, `account_id`, `category_id`, `merchant_key`, `version`, `user_id`) SELECT `id`, `description`, `amount`, `type`, `period`, `next_due`, `currency`, `account_id`, `category_id`, `merchant_key`, `version`, (SELECT `id` FROM `users` WHERE `id` = 'user-owner') FROM `recurring_rules`;
--> statement-breakpoint
DROP TABLE `recurring_rules`;
--> statement-breakpoint
ALTER TABLE `__new_recurring_rules` RENAME TO `recurring_rules`;
--> statement-breakpoint
-- transactions: owned by a user.
CREATE TABLE `__new_transactions` (
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
	`status` text DEFAULT 'effective' NOT NULL,
	`note` text,
	`version` integer DEFAULT 0 NOT NULL,
	`user_id` text NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`currency`) REFERENCES `currencies`(`code`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`from_account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`to_account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`credit_card_id`) REFERENCES `credit_cards`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`category_id`) REFERENCES `categories`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`subcategory_id`) REFERENCES `categories`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`merchant_key`) REFERENCES `merchants`(`key`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`bill_id`) REFERENCES `bills`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "subcategory_requires_category" CHECK(`subcategory_id` IS NULL OR `category_id` IS NOT NULL)
);
--> statement-breakpoint
INSERT INTO `__new_transactions` (`rowid`, `id`, `description`, `amount`, `type`, `date`, `currency`, `source`, `idempotency_key`, `classification_method`, `confidence`, `raw_input`, `from_account_id`, `to_account_id`, `credit_card_id`, `category_id`, `subcategory_id`, `merchant_key`, `bill_id`, `status`, `note`, `version`, `user_id`) SELECT `rowid`, `id`, `description`, `amount`, `type`, `date`, `currency`, `source`, `idempotency_key`, `classification_method`, `confidence`, `raw_input`, `from_account_id`, `to_account_id`, `credit_card_id`, `category_id`, `subcategory_id`, `merchant_key`, `bill_id`, `status`, `note`, `version`, (SELECT `id` FROM `users` WHERE `id` = 'user-owner') FROM `transactions`;
--> statement-breakpoint
DROP TABLE `transactions`;
--> statement-breakpoint
ALTER TABLE `__new_transactions` RENAME TO `transactions`;
--> statement-breakpoint
-- transactions keep their rowid so the external-content FTS index (transactions_fts, keyed by rowid) stays valid.
-- Dropping the table dropped its three sync triggers (0001_fts5_search.sql); they come back after the indexes. The copy above ran
-- before them, so no row was indexed twice.
CREATE UNIQUE INDEX `transactions_user_idempotency_key` ON `transactions` (`user_id`,`idempotency_key`);
--> statement-breakpoint
CREATE INDEX `idx_transactions_user_date` ON `transactions` (`user_id`,`date`);
--> statement-breakpoint
CREATE INDEX `idx_transactions_category` ON `transactions` (`category_id`);
--> statement-breakpoint
CREATE INDEX `idx_transactions_date` ON `transactions` (`date`);
--> statement-breakpoint
CREATE INDEX `idx_transactions_from_account` ON `transactions` (`from_account_id`);
--> statement-breakpoint
CREATE INDEX `idx_transactions_status_date` ON `transactions` (`status`,`date`);
--> statement-breakpoint
CREATE INDEX `idx_transactions_to_account` ON `transactions` (`to_account_id`);
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS transactions_fts_insert
  AFTER INSERT ON transactions BEGIN
    INSERT INTO transactions_fts(rowid, description) VALUES (new.rowid, new.description);
  END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS transactions_fts_update
  AFTER UPDATE OF description ON transactions BEGIN
    INSERT INTO transactions_fts(transactions_fts, rowid, description)
      VALUES ('delete', old.rowid, old.description);
    INSERT INTO transactions_fts(rowid, description) VALUES (new.rowid, new.description);
  END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS transactions_fts_delete
  AFTER DELETE ON transactions BEGIN
    INSERT INTO transactions_fts(transactions_fts, rowid, description)
      VALUES ('delete', old.rowid, old.description);
  END;
--> statement-breakpoint
-- categories: the 15 defaults FinTrack seeds stay shared (user_id null); every other category was made by a person — the owner.
-- The list is the seeded ids as of this migration (DefaultCategoryId); later seeds are shared by construction.
ALTER TABLE `categories` ADD COLUMN `user_id` text REFERENCES `users`(`id`) ON UPDATE no action ON DELETE restrict;
--> statement-breakpoint
UPDATE `categories` SET `user_id` = (SELECT `id` FROM `users` WHERE `id` = 'user-owner') WHERE `id` NOT IN ('cat-food', 'cat-transport', 'cat-housing', 'cat-utilities', 'cat-health', 'cat-education', 'cat-leisure', 'cat-shopping', 'cat-subscriptions', 'cat-travel', 'cat-taxes', 'cat-salary', 'cat-extra-income', 'cat-investments', 'cat-other');
--> statement-breakpoint
-- merchant_category: `rule` edges ship with FinTrack and stay shared; `history` edges were learned from the owner's corrections.
-- The (merchant_key, category_id) primary key becomes one unique index per audience, since NULLs are distinct in a UNIQUE index.
CREATE TABLE `__new_merchant_category` (
	`merchant_key` text NOT NULL,
	`category_id` text NOT NULL,
	`weight` real DEFAULT 1 NOT NULL,
	`origin` text NOT NULL,
	`last_seen` integer,
	`user_id` text,
	FOREIGN KEY (`merchant_key`) REFERENCES `merchants`(`key`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`category_id`) REFERENCES `categories`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "merchant_category_origin_owner" CHECK((`origin` = 'rule' AND `user_id` IS NULL) OR (`origin` = 'history' AND `user_id` IS NOT NULL))
);
--> statement-breakpoint
INSERT INTO `__new_merchant_category` (`merchant_key`, `category_id`, `weight`, `origin`, `last_seen`, `user_id`)
SELECT `merchant_key`, `category_id`, `weight`, `origin`, `last_seen`, CASE WHEN `origin` = 'history' THEN (SELECT `id` FROM `users` WHERE `id` = 'user-owner') END FROM `merchant_category`;
--> statement-breakpoint
DROP TABLE `merchant_category`;
--> statement-breakpoint
ALTER TABLE `__new_merchant_category` RENAME TO `merchant_category`;
--> statement-breakpoint
CREATE UNIQUE INDEX `merchant_category_shared_key` ON `merchant_category` (`merchant_key`,`category_id`) WHERE `user_id` IS NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX `merchant_category_user_key` ON `merchant_category` (`user_id`,`merchant_key`,`category_id`) WHERE `user_id` IS NOT NULL;
--> statement-breakpoint
-- dashboards: the file-backed defaults stay shared; every saved (inline) dashboard is the owner's.
CREATE TABLE `__new_dashboards` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`html` text,
	`source` text DEFAULT 'inline' NOT NULL,
	`path` text,
	`updated_at` text NOT NULL,
	`version` integer DEFAULT 0 NOT NULL,
	`user_id` text,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "dashboard_source_owner" CHECK((`source` = 'file' AND `user_id` IS NULL) OR (`source` = 'inline' AND `user_id` IS NOT NULL)),
	CONSTRAINT "dashboard_source_content" CHECK((`source` = 'inline' AND `html` IS NOT NULL AND `path` IS NULL) OR (`source` = 'file' AND `html` IS NULL AND `path` IS NOT NULL))
);
--> statement-breakpoint
INSERT INTO `__new_dashboards` (`id`, `name`, `html`, `source`, `path`, `updated_at`, `version`, `user_id`)
SELECT `id`, `name`, `html`, `source`, `path`, `updated_at`, `version`, CASE WHEN `source` = 'inline' THEN (SELECT `id` FROM `users` WHERE `id` = 'user-owner') END FROM `dashboards`;
--> statement-breakpoint
DROP TABLE `dashboards`;
--> statement-breakpoint
ALTER TABLE `__new_dashboards` RENAME TO `dashboards`;
--> statement-breakpoint
CREATE UNIQUE INDEX `dashboards_shared_name` ON `dashboards` (`name`) WHERE `user_id` IS NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX `dashboards_user_name` ON `dashboards` (`user_id`,`name`) WHERE `user_id` IS NOT NULL;
