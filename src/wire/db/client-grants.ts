import type { clientGrants } from '../../diplomat/db/schema.js';

export type ClientGrantRow = typeof clientGrants.$inferSelect;
