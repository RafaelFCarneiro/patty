import { eq, sql } from 'drizzle-orm';
import * as creditCardAdapters from '../../../adapters/creditCards.js';
import { CreditCardSchema, type CreditCard, type CreditCardEntity } from '../../../models/creditCard.js';
import type { CreditCardRow } from '../../../wire/db/creditCards.js';
import type { Db } from '../driver.js';
import { creditCards } from '../schema.js';
import { versionedTableApplier, type EntityApplier } from '../unitOfWork.js';
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
  /** Version-carrying read (ADR-021) — for `deleteCreditCard`, which needs it to build a
   *  version-guarded `Persistable`. */
  findRawById: (id: string) => Promise<CreditCardEntity | null>;
  countCorrelated: (cardId: string, accountId: string) => Promise<DeleteCardCounts>;
};

export const creditCardsRepo = (db: Db): CreditCardsRepo => ({
  list: async () => {
    const rows = await db.select().from(creditCards).orderBy(creditCards.name);
    return rows.map(toCard);
  },

  findByName: async (name) => {
    const rows = await db
      .select()
      .from(creditCards)
      .where(sql`lower(${creditCards.name}) = lower(${name})`)
      .limit(1);
    return rows[0] ? toCard(rows[0]) : null;
  },

  findById: async (id) => {
    const rows = await db.select().from(creditCards).where(eq(creditCards.id, id)).limit(1);
    return rows[0] ? toCard(rows[0]) : null;
  },

  findRawById: async (id) => {
    const rows = await db.select().from(creditCards).where(eq(creditCards.id, id)).limit(1);
    return rows[0] ? creditCardAdapters.dbToEntity(rows[0]) : null;
  },

  countCorrelated: async (cardId, accountId) => {
    const [txRow] = await db.all<{ count: number }>(
      sql`SELECT COUNT(*) as count FROM transactions WHERE ${correlatedToCard(cardId, accountId)}`,
    );
    const [billRow] = await db.all<{ count: number }>(sql`
      SELECT COUNT(*) as count FROM bills WHERE credit_card_id = ${cardId}
    `);
    return { transactions: txRow?.count ?? 0, bills: billRow?.count ?? 0 };
  },
});

/** Deleting a card cascades to its correlated bills/transactions, but that's decided in
 *  `deleteCreditCard` (`controllers/creditCard/creditCard.ts`), which emits their own
 *  `Persistable`s ahead of the card's — this applier just writes the row it's handed. */
export const creditCardApplier: EntityApplier = versionedTableApplier(creditCards);
