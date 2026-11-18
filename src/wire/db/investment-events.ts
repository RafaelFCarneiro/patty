import type { investmentEvents } from '../../diplomat/db/schema.js';
import type { WithoutOwner } from './tenancy.js';

// Investment event row from a Drizzle select, as the versioned unit of work writes it: the owner is stamped by the
// scoped applier and the idempotency key is merged on by it (envelope metadata, never a model field).
export type InvestmentEventRow = Omit<WithoutOwner<typeof investmentEvents.$inferSelect>, 'idempotencyKey'>;
