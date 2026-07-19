import type { settings } from '../../diplomat/db/schema.js';

export type SettingsRow = typeof settings.$inferSelect;
