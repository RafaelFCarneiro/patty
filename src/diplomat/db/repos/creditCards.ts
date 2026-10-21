import { eq, sql } from 'drizzle-orm';
import * as creditCardAdapters from '../../../adapters/creditCards.js';
import { CreditCardSchema, type CreditCard, type CreditCardEntity } from '../../../models/creditCard.js';
import type { CreditCardRow } from '../../../wire/db/creditCards.js';
import type { Db } from '../driver.js';
import { creditCards } from '../schema.js';
import { ownedTableApplier, type EntityApplier } from '../effects.js';
import { ownedBy, ownedWhere, type RepoScope } from '../queries/scope.js';
import { correlatedToCard } from './transactions.js';

const toCard = (row: CreditCardRow): CreditCard =>
  CreditCardSchema.parse({
    id: row.id,
    name: row.name,
    currency: row.currency,
    closingDay: row.closingDay,
    dueDay: row.dueDay,
    limit: row.limitAmount ?? undefined,
    accountId: row.accountId,
    paymentAccountId: row.paymentAccountId ?? undefined,
  });

export type DeleteCardCounts = { transactions: number; bills: number };

export type CreditCardsRepo = {
  list: () => Promise<CreditCard[]>;
  findByName: (name: string) => Promise<CreditCard | null>;
  findById: (id: string) => Promise<CreditCard | null>;
  findRawById: (id: string) => Promise<CreditCardEntity | null>;
  countCorrelated: (cardId: string, accountId: string) => Promise<DeleteCardCounts>;
};

const list = async ({ db, userId }: RepoScope): ReturnType<CreditCardsRepo['list']> => {
  const rows = await db
    .select()
    .from(creditCards)
    .where(ownedWhere(creditCards.userId, userId))
    .orderBy(creditCards.name);
  return rows.map(toCard);
};

const findByName = async ({ db, userId }: RepoScope, name: string): ReturnType<CreditCardsRepo['findByName']> => {
  const rows = await db
    .select()
    .from(creditCards)
    .where(ownedWhere(creditCards.userId, userId, sql`lower(${creditCards.name}) = lower(${name})`))
    .limit(1);
  return rows[0] ? toCard(rows[0]) : null;
};

const findById = async ({ db, userId }: RepoScope, id: string): ReturnType<CreditCardsRepo['findById']> => {
  const rows = await db
    .select()
    .from(creditCards)
    .where(ownedWhere(creditCards.userId, userId, eq(creditCards.id, id)))
    .limit(1);
  return rows[0] ? toCard(rows[0]) : null;
};

const findRawById = async ({ db, userId }: RepoScope, id: string): ReturnType<CreditCardsRepo['findRawById']> => {
  const rows = await db
    .select()
    .from(creditCards)
    .where(ownedWhere(creditCards.userId, userId, eq(creditCards.id, id)))
    .limit(1);
  return rows[0] ? creditCardAdapters.dbToEntity(rows[0]) : null;
};

const countCorrelated = async (
  { db, userId }: RepoScope,
  cardId: string,
  accountId: string,
): ReturnType<CreditCardsRepo['countCorrelated']> => {
  const [txRow] = await db.all<{ count: number }>(
    sql`SELECT COUNT(*) as count FROM transactions WHERE ${ownedBy(userId)} AND (${correlatedToCard(cardId, accountId)})`,
  );
  const [billRow] = await db.all<{ count: number }>(sql`
      SELECT COUNT(*) as count FROM bills WHERE ${ownedBy(userId)} AND credit_card_id = ${cardId}
    `);
  return { transactions: txRow?.count ?? 0, bills: billRow?.count ?? 0 };
};

export const creditCardsRepo = (db: Db, userId: string): CreditCardsRepo => {
  const scope: RepoScope = { db, userId };
  return {
    list: () => list(scope),
    findByName: (name) => findByName(scope, name),
    findById: (id) => findById(scope, id),
    findRawById: (id) => findRawById(scope, id),
    countCorrelated: (cardId, accountId) => countCorrelated(scope, cardId, accountId),
  };
};

export const creditCardApplier = (userId: string): EntityApplier => ownedTableApplier(creditCards, userId);
