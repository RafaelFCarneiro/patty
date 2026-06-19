CREATE TABLE `settings` (
	`id` text PRIMARY KEY DEFAULT 'singleton' NOT NULL,
	`locale` text DEFAULT 'en' NOT NULL,
	`locale_source` text DEFAULT 'default' NOT NULL
);
--> statement-breakpoint
ALTER TABLE `categories` ADD `names` text;