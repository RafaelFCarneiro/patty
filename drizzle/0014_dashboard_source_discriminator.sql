PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_dashboards` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`html` text,
	`source` text DEFAULT 'inline' NOT NULL,
	`path` text,
	`updated_at` text NOT NULL,
	`version` integer DEFAULT 0 NOT NULL,
	CONSTRAINT "dashboard_source_content" CHECK(("__new_dashboards"."source" = 'inline' AND "__new_dashboards"."html" IS NOT NULL AND "__new_dashboards"."path" IS NULL) OR ("__new_dashboards"."source" = 'file' AND "__new_dashboards"."html" IS NULL AND "__new_dashboards"."path" IS NOT NULL))
);
--> statement-breakpoint
INSERT INTO `__new_dashboards`("id", "name", "html", "source", "path", "updated_at", "version") SELECT "id", "name", "html", 'inline', NULL, "updated_at", "version" FROM `dashboards`;--> statement-breakpoint
DROP TABLE `dashboards`;--> statement-breakpoint
ALTER TABLE `__new_dashboards` RENAME TO `dashboards`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `dashboards_name_unique` ON `dashboards` (`name`);