import type { settings, userSettings } from '../../diplomat/db/schema.js';

export type SettingsRow = typeof settings.$inferSelect;

export type UserSettingsRow = Omit<typeof userSettings.$inferSelect, 'userId'>;
