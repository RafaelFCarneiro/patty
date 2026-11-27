-- Feature Design 025: a bill's payments are read from its transfers (`bill_id`), so the single-payment pointer goes after being copied onto the transfer it names. The table is rebuilt because SQLite cannot drop a column that carries a foreign key; that needs foreign keys OFF, and the guard below aborts otherwise.
CREATE TABLE `__fk_guard` (`enforcement_is_off` integer NOT NULL);
--> statement-breakpoint
INSERT INTO `__fk_guard` SELECT CASE WHEN `foreign_keys` = 0 THEN 1 END FROM pragma_foreign_keys;
--> statement-breakpoint
DROP TABLE `__fk_guard`;
--> statement-breakpoint
UPDATE `transactions` SET `bill_id` = (SELECT `b`.`id` FROM `bills` `b` WHERE `b`.`payment_transaction_id` = `transactions`.`id`) WHERE `bill_id` IS NULL AND `id` IN (SELECT `payment_transaction_id` FROM `bills` WHERE `payment_transaction_id` IS NOT NULL);
--> statement-breakpoint
CREATE TABLE `__new_bills` (
	`id` text PRIMARY KEY NOT NULL,
	`credit_card_id` text NOT NULL,
	`month` integer NOT NULL,
	`year` integer NOT NULL,
	`close_date` text NOT NULL,
	`due_date` text NOT NULL,
	`status` text NOT NULL,
	`version` integer DEFAULT 0 NOT NULL,
	`user_id` text NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`credit_card_id`) REFERENCES `credit_cards`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
INSERT INTO `__new_bills` (`id`, `credit_card_id`, `month`, `year`, `close_date`, `due_date`, `status`, `version`, `user_id`) SELECT `id`, `credit_card_id`, `month`, `year`, `close_date`, `due_date`, `status`, `version`, `user_id` FROM `bills`;
--> statement-breakpoint
DROP TABLE `bills`;
--> statement-breakpoint
ALTER TABLE `__new_bills` RENAME TO `bills`;
--> statement-breakpoint
CREATE UNIQUE INDEX `bills_card_month_year` ON `bills` (`credit_card_id`,`month`,`year`);
