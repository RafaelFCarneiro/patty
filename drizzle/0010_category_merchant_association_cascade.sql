PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_merchant_category` (
	`merchant_key` text NOT NULL,
	`category_id` text NOT NULL,
	`weight` real DEFAULT 1 NOT NULL,
	`origin` text NOT NULL,
	`last_seen` integer,
	PRIMARY KEY(`merchant_key`, `category_id`),
	FOREIGN KEY (`merchant_key`) REFERENCES `merchants`(`key`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`category_id`) REFERENCES `categories`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
INSERT INTO `__new_merchant_category`("merchant_key", "category_id", "weight", "origin", "last_seen") SELECT "merchant_key", "category_id", "weight", "origin", "last_seen" FROM `merchant_category`;--> statement-breakpoint
DROP TABLE `merchant_category`;--> statement-breakpoint
ALTER TABLE `__new_merchant_category` RENAME TO `merchant_category`;--> statement-breakpoint
PRAGMA foreign_keys=ON;