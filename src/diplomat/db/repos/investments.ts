import { and, eq } from 'drizzle-orm';
import * as investmentAdapters from '../../../adapters/investment-events.js';
import type { InvestmentEventEntity } from '../../../models/investment/core.js';
import type { Db } from '../driver.js';
import { investmentEvents } from '../schema.js';
import { ownedTableApplier, uniqueViolationAsConflict, type EntityApplier } from '../effects.js';
import { ownedWhere, type RepoScope } from '../queries/scope.js';

export type InvestmentEventFilter = { accountId?: string; assetId?: string };

export type InvestmentsRepo = {
  list: (filter?: InvestmentEventFilter) => Promise<InvestmentEventEntity[]>;
  findById: (id: string) => Promise<InvestmentEventEntity | null>;
};

const list = async ({ db, userId }: RepoScope, filter: InvestmentEventFilter = {}) => {
  const narrowing = [
    filter.accountId === undefined ? undefined : eq(investmentEvents.accountId, filter.accountId),
    filter.assetId === undefined ? undefined : eq(investmentEvents.assetId, filter.assetId),
  ];
  const rows = await db
    .select()
    .from(investmentEvents)
    .where(ownedWhere(investmentEvents.userId, userId, and(...narrowing)))
    .orderBy(investmentEvents.date, investmentEvents.id);
  return rows.map(investmentAdapters.dbToEntity);
};

const findById = async ({ db, userId }: RepoScope, id: string): Promise<InvestmentEventEntity | null> => {
  const [row] = await db
    .select()
    .from(investmentEvents)
    .where(ownedWhere(investmentEvents.userId, userId, eq(investmentEvents.id, id)))
    .limit(1);
  return row ? investmentAdapters.dbToEntity(row) : null;
};

export const investmentsRepo = (db: Db, userId: string): InvestmentsRepo => {
  const scope: RepoScope = { db, userId };
  return {
    list: (filter) => list(scope, filter),
    findById: (id) => findById(scope, id),
  };
};

export const investmentEventApplier = (userId: string): EntityApplier =>
  uniqueViolationAsConflict(ownedTableApplier(investmentEvents, userId, { readBack: async (_tx, id) => id }));
