-- ADR-036: change notifications between the processes sharing this database (entity tags only, never data; rows live minutes). Infrastructure: no repo, no applier, no owner.
CREATE TABLE `change_events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` text,
	`entities` text NOT NULL,
	`origin` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `change_events_created_at_idx` ON `change_events` (`created_at`);