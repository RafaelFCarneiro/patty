-- The instance settings singleton always exists, so a flow reads and checks it like any other row instead of inserting it on first use.
INSERT OR IGNORE INTO `settings` (`id`, `max_sign_in_duration`, `version`) VALUES ('singleton', '30d', 0);
