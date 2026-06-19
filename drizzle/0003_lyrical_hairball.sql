ALTER TABLE `transactions` ADD `status` text DEFAULT 'effective' NOT NULL;--> statement-breakpoint
CREATE INDEX `idx_transactions_status_date` ON `transactions` (`status`,`date`);