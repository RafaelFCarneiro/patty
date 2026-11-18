import * as persistence from '../logic/persistence.js';
import {
  INVESTMENT_EVENT_ENTITY_TAG,
  InvestmentEventEntitySchema,
  type InvestmentEventEntity,
} from '../models/investment.js';
import type { InvestmentEventRow } from '../wire/db/investment-events.js';

export const dbToEntity = (row: InvestmentEventRow): InvestmentEventEntity =>
  InvestmentEventEntitySchema.parse({
    id: row.id,
    accountId: row.accountId,
    assetId: row.assetId,
    type: row.type,
    date: row.date,
    quantity: row.quantity,
    unitCost: row.unitCost,
    note: row.note,
    replacedCash: row.replacedCash,
    version: row.version,
  });

// Identity: a versioned InvestmentEventEntity is already row-shaped; the scoped applier stamps the owner and merges the
// idempotency key on the way in.
export const modelToDb = (entity: InvestmentEventEntity): InvestmentEventRow => entity;

export const { persistableToDb, outcomeToDb } = persistence.entityDbAdapter(INVESTMENT_EVENT_ENTITY_TAG, modelToDb);
