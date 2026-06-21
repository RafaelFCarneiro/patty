ALTER TABLE `credit_cards` ADD `account_id` text REFERENCES accounts(id);--> statement-breakpoint
ALTER TABLE `credit_cards` ADD `payment_account_id` text REFERENCES accounts(id);