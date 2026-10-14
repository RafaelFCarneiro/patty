import type { settings, userSettings } from '../../diplomat/db/schema.js';

/** The instance-wide settings row (`id` + `version` today). */
export type SettingsRow = typeof settings.$inferSelect;

/** A user's preferences row as a flow writes it — keyed by `user_id`, which the scoped applier supplies. */
export type UserSettingsRow = Omit<typeof userSettings.$inferSelect, 'userId'>;
