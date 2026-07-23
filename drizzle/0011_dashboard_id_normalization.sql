PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_dashboards` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`html` text NOT NULL,
	`updated_at` text NOT NULL,
	`version` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
INSERT INTO `__new_dashboards`("id", "name", "html", "updated_at", "version") SELECT
	lower(hex(randomblob(4)) || '-' || hex(randomblob(2)) || '-4' || substr(hex(randomblob(2)), 2) || '-' || substr('89ab', abs(random()) % 4 + 1, 1) || substr(hex(randomblob(2)), 2) || '-' || hex(randomblob(6))),
	"name", "html", "updated_at", "version" FROM `dashboards`;--> statement-breakpoint
DROP TABLE `dashboards`;--> statement-breakpoint
ALTER TABLE `__new_dashboards` RENAME TO `dashboards`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `dashboards_name_unique` ON `dashboards` (`name`);
