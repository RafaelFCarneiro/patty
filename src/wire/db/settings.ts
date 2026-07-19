import type { settings } from '../../diplomat/db/schema.js';

// Settings row from a Drizzle select — derived from schema.ts (single source of truth).
export type SettingsRow = typeof settings.$inferSelect;
