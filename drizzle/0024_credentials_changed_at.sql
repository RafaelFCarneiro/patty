-- When this user's set of ways in (sessions, tokens, sign-in requests, invites) last changed. Issuing or ending a credential writes it, so a revocation that read the credentials earlier conflicts with the issuance and re-reads them.
ALTER TABLE `users` ADD `credentials_changed_at` text;
