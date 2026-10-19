CREATE TABLE `invites` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`code_hash` text NOT NULL,
	`created_by` text,
	`created_at` text NOT NULL,
	`expires_at` text NOT NULL,
	`used_at` text,
	`version` integer DEFAULT 0 NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE UNIQUE INDEX `invites_code_hash_unique` ON `invites` (`code_hash`);--> statement-breakpoint
CREATE UNIQUE INDEX `invites_one_open_per_user` ON `invites` (`user_id`) WHERE "invites"."used_at" IS NULL;--> statement-breakpoint
ALTER TABLE `settings` ADD `max_sign_in_duration` text DEFAULT '30d' NOT NULL;--> statement-breakpoint
ALTER TABLE `users` ADD `last_login_at` text;