import type { tags } from '../../diplomat/db/schema.js';
import type { WithoutOwner } from './tenancy.js';

// Tag row from a Drizzle select — derived from schema.ts (single source of truth).
export type TagRow = WithoutOwner<typeof tags.$inferSelect>;
