import type { creditCards } from '../../diplomat/db/schema.js';
import type { WithoutOwner } from './tenancy.js';

// Credit-card row from a Drizzle select — derived from schema.ts (single source of truth).
export type CreditCardRow = WithoutOwner<typeof creditCards.$inferSelect>;
