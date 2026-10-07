import type { sessions } from '../../diplomat/db/schema.js';

export type SessionRow = typeof sessions.$inferSelect;
