import { and, eq } from 'drizzle-orm';
import * as investmentAdapters from '../../../adapters/investment-events.js';
import type { InvestmentEventEntity } from '../../../models/investment.js';
import type { Db } from '../driver.js';
import { investmentEvents } from '../schema.js';
import { ownedTableApplier, type EntityApplier } from '../effects.js';
import { ownedWhere, type RepoScope } from '../queries/scope.js';

export type InvestmentEventFilter = { accountId?: string; assetId?: string };

export type InvestmentsRepo = {
  /** The caller's events, oldest first, optionally narrowed to one account and/or asset. */
  list: (filter?: InvestmentEventFilter) => Promise<InvestmentEventEntity[]>;
  /** One of the caller's events by id, with its version — another user's id is simply not found. */
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

export const investmentEventApplier = (userId: string): EntityApplier => ownedTableApplier(investmentEvents, userId);
