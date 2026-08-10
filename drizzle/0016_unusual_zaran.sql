CREATE TABLE `currency_rates` (
	`id` text PRIMARY KEY NOT NULL,
	`from_code` text NOT NULL,
	`to_code` text NOT NULL,
	`rate` real NOT NULL,
	`as_of` text NOT NULL,
	`source` text,
	`version` integer DEFAULT 0 NOT NULL,
	FOREIGN KEY (`from_code`) REFERENCES `currencies`(`code`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`to_code`) REFERENCES `currencies`(`code`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `currency_rates_from_to` ON `currency_rates` (`from_code`,`to_code`);