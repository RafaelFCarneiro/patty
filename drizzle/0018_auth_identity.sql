CREATE TABLE `sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`token_hash` text NOT NULL,
	`created_at` text NOT NULL,
	`last_seen_at` text NOT NULL,
	`expires_at` text NOT NULL,
	`version` integer DEFAULT 0 NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `sessions_token_hash_unique` ON `sessions` (`token_hash`);--> statement-breakpoint
CREATE TABLE `setup_codes` (
	`id` text PRIMARY KEY NOT NULL,
	`code_hash` text NOT NULL,
	`created_at` text NOT NULL,
	`expires_at` text NOT NULL,
	`used_at` text,
	`version` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `setup_codes_code_hash_unique` ON `setup_codes` (`code_hash`);--> statement-breakpoint
CREATE TABLE `users` (
	`id` text PRIMARY KEY NOT NULL,
	`username` text,
	`password_hash` text,
	`role` text NOT NULL,
	`created_at` text NOT NULL,
	`disabled_at` text,
	`version` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `users_username_unique` ON `users` (`username`);
--> statement-breakpoint
-- ADR-033 §7: the owner is a row, created here on EVERY database (fresh or existing) so that stdio,
-- auth-disabled requests and the setup-code claim all resolve to the same user. No credentials yet.
-- The id must equal OWNER_USER_ID (src/models/auth.ts). Touches no existing domain table.
INSERT INTO `users` (`id`, `username`, `password_hash`, `role`, `created_at`, `disabled_at`, `version`)
VALUES ('user-owner', NULL, NULL, 'admin', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), NULL, 0);
