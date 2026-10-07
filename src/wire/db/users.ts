import type { users } from '../../diplomat/db/schema.js';

export type UserRow = typeof users.$inferSelect;
