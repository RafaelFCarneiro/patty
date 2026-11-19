import type { investmentEvents } from '../../diplomat/db/schema.js';
import type { WithoutOwner } from './tenancy.js';

export type InvestmentEventRow = Omit<WithoutOwner<typeof investmentEvents.$inferSelect>, 'idempotencyKey'>;
