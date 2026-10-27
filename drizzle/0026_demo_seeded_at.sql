-- When the demo seeder finished: null on a standard database, and on a demo whose seed was interrupted (which `demo` then reports instead of treating as seeded).
ALTER TABLE `settings` ADD `demo_seeded_at` text;
