CREATE TABLE `client_grants` (
	`id` text PRIMARY KEY NOT NULL,
	`device_code_hash` text NOT NULL,
	`user_code` text NOT NULL,
	`client_name` text NOT NULL,
	`client_version` text NOT NULL,
	`profile` text NOT NULL,
	`channel` text DEFAULT 'stdio' NOT NULL,
	`hint_access` text,
	`hint_duration` text,
	`status` text DEFAULT 'pending' NOT NULL,
	`user_id` text,
	`scopes` text,
	`duration` text,
	`created_at` text NOT NULL,
	`approved_at` text,
	`expires_at` text NOT NULL,
	`version` integer DEFAULT 0 NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `client_grants_device_code_hash_unique` ON `client_grants` (`device_code_hash`);--> statement-breakpoint
CREATE UNIQUE INDEX `client_grants_pending_user_code` ON `client_grants` (`user_code`) WHERE "client_grants"."status" = 'pending';--> statement-breakpoint
CREATE INDEX `client_grants_user_code_idx` ON `client_grants` (`user_code`);--> statement-breakpoint
ALTER TABLE `access_tokens` ADD `kind` text DEFAULT 'pat' NOT NULL;--> statement-breakpoint
ALTER TABLE `access_tokens` ADD `client_name` text;--> statement-breakpoint
ALTER TABLE `access_tokens` ADD `profile` text;