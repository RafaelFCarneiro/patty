import type { invites } from '../../diplomat/db/schema.js';

export type InviteRow = typeof invites.$inferSelect;
