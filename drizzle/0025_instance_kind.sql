-- What this database says it is. Only the demo seeder writes 'demo'; the banner, the MCP instructions and get_status read it, never a file name or an env var.
ALTER TABLE `settings` ADD `instance_kind` text DEFAULT 'standard' NOT NULL;
