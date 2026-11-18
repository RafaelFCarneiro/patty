import { and, eq } from 'drizzle-orm';
import * as investmentAdapters from '../../../adapters/investment-events.js';
import type { InvestmentEventEntity } from '../../../models/investment.js';
import type { Db } from '../driver.js';
import { investmentEvents } from '../schema.js';
import { isUniqueConstraintViolation } from '../sqlite-errors.js';
import { VersionConflict, ownedTableApplier, type EntityApplier } from '../effects.js';
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

/** `investment_events` has the secondary partial `UNIQUE(user_id, account_id, asset_id) WHERE type = 'opening'` beyond
 *  `openPosition`'s own pre-check: two concurrent openings of one position race into a real unique violation the key's
 *  `onConflictDoNothing` doesn't swallow. It is rethrown as `VersionConflict`, so the loser's retry re-reads, finds the
 *  winner's opening and answers the ordinary "already has an opening" validation error rather than a 500. */
export const investmentEventApplier = (userId: string): EntityApplier => {
  const scoped = ownedTableApplier(investmentEvents, userId);
  return {
    ...scoped,
    insert: async (tx, model, idempotencyKey) => {
      try {
        return await scoped.insert(tx, model, idempotencyKey);
      } catch (cause) {
        if (isUniqueConstraintViolation(cause)) throw new VersionConflict();
        throw cause;
      }
    },
  };
};
