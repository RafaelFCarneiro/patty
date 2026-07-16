import { eq, sql } from 'drizzle-orm';
import * as creditCardAdapters from '../../../adapters/creditCards.js';
import { expectPresent, rowNotFoundAfterWrite } from '../present.js';
import type { Account } from '../../../models/account.js';
import { CreditCardSchema, type CreditCard, type CreditCardEntity } from '../../../models/creditCard.js';
import type { CreditCardRow } from '../../../wire/db/creditCards.js';
import { correlatedToCard } from '../creditCardCorrelation.js';
import type { Db } from '../driver.js';
import { accounts, bills, creditCards } from '../schema.js';
import { versionedTableApplier, type EntityApplier, type Tx } from '../unitOfWork.js';

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

// Cascades every row correlated to the card (bill-payment references, tags, transactions, bills)
// ahead of the card row itself — FK-safe order: clear bills' reference to their payment transfer
// first (bills.payment_transaction_id → transactions.id would otherwise block deleting a
// bill-payment row below), then tags → transactions → bills. Used only by the plain repo
// `deleteCard` below — kept, though no longer called by `deleteCreditCard` (which now decides this
// cascade itself, in the domain — see `creditCardApplier`'s doc comment), per ADR-021 phase 3d:
// repo write methods are removed only once every caller has converted.
const cascadeDeleteCorrelated = async (tx: Tx, cardId: string, accountId: string): Promise<void> => {
  await tx.update(bills).set({ paymentTransactionId: null }).where(eq(bills.creditCardId, cardId));
  await tx.run(sql`
    DELETE FROM transaction_tags WHERE transaction_id IN (
      SELECT id FROM transactions WHERE ${correlatedToCard(cardId, accountId)}
    )
  `);
  await tx.run(sql`DELETE FROM transactions WHERE ${correlatedToCard(cardId, accountId)}`);
  await tx.delete(bills).where(eq(bills.creditCardId, cardId));
};

export type DeleteCardCounts = { transactions: number; bills: number };

export type CreditCardsRepo = {
  list: () => Promise<CreditCard[]>;
  createWithAccount: (card: CreditCard, account: Account) => Promise<CreditCard>;
  findByName: (name: string) => Promise<CreditCard | null>;
  findById: (id: string) => Promise<CreditCard | null>;
  /** Version-carrying read (ADR-021) — for `deleteCreditCard`, which needs it to build a
   *  version-guarded `Persistable`. */
  findRawById: (id: string) => Promise<CreditCardEntity | null>;
  countCorrelated: (cardId: string, accountId: string) => Promise<DeleteCardCounts>;
  deleteCard: (cardId: string, accountId: string) => Promise<void>;
};

export const creditCardsRepo = (db: Db): CreditCardsRepo => ({
  list: async () => {
    const rows = await db.select().from(creditCards).orderBy(creditCards.name);
    return rows.map(toCard);
  },

  createWithAccount: async (card, account) => {
    const [row] = await db.transaction(async (tx) => {
      await tx.insert(accounts).values({
        id: account.id,
        name: account.name,
        type: account.type,
        initialBalance: account.initialBalance,
        currency: account.currency,
      });
      return tx
        .insert(creditCards)
        .values({
          id: card.id,
          name: card.name,
          currency: card.currency,
          closingDay: card.closingDay,
          dueDay: card.dueDay,
          limitAmount: card.limit ?? null,
          accountId: card.accountId,
          paymentAccountId: card.paymentAccountId ?? null,
        })
        .returning();
    });
    return toCard(expectPresent(row, rowNotFoundAfterWrite('credit_cards', 'insert')));
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

  deleteCard: async (cardId, accountId) => {
    await db.transaction(async (tx) => {
      await cascadeDeleteCorrelated(tx, cardId, accountId);
      await tx.delete(creditCards).where(eq(creditCards.id, cardId));
      await tx.delete(accounts).where(eq(accounts.id, accountId));
    });
  },
});

/**
 * The credit-card entity's `EntityApplier` (ADR-021). Plain `versionedTableApplier` — deleting a
 * card row has no mechanics beyond the ordinary `id`/`version` convention. It did once: an earlier
 * version of this applier read the card's own `accountId` back and cascade-deleted every
 * correlated bill/transaction/tag itself, mirroring the pre-ADR-021 `deleteCard` above. That was
 * the repo deciding a business question — "what happens when a card is deleted" — the exact
 * ADR-015/018 smell ADR-021 exists to remove, just recurring one layer down. The cascade decision
 * now lives in the domain: `deleteCreditCard` (`controllers/creditCard/creditCard.ts`) reads the
 * card's correlated bills/transactions itself and emits their `update`/`delete` `Persistable`s
 * explicitly, ahead of the card's own — this applier only ever writes the row it's handed, same as
 * every other plain entity.
 */
export const creditCardApplier: EntityApplier = versionedTableApplier(creditCards);
