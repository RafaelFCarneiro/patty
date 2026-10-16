import { eq, sql } from 'drizzle-orm';
import * as accountAdapters from '../../../adapters/accounts.js';
import type { Account, AccountEntity, AccountReferences } from '../../../models/account.js';
import { TransactionStatus, TransactionType } from '../../../models/transaction.js';
import { BalancePartsRow } from '../../../wire/db/accounts.js';
import type { Db } from '../driver.js';
import { accounts, creditCards, recurringRules, transactions } from '../schema.js';
import { ownedTableApplier, type EntityApplier } from '../effects.js';
import { ownedBy, ownedWhere } from '../queries/scope.js';

export type AccountsRepo = {
  list: () => Promise<Account[]>;
  findById: (id: string) => Promise<Account | null>;
  findByName: (name: string) => Promise<Account | null>;
  /** Version-carrying read — for flows building an `update`/`delete` `Persistable`. */
  findRawById: (id: string) => Promise<AccountEntity | null>;
  /** Aggregated movement per account: transactions + transfers, both directions. */
  balanceParts: (accountId: string) => Promise<BalancePartsRow>;
  countReferences: (accountId: string) => Promise<AccountReferences>;
};

export const accountsRepo = (db: Db, userId: string): AccountsRepo => ({
  list: async () => {
    const rows = await db.select().from(accounts).where(ownedWhere(accounts.userId, userId)).orderBy(accounts.name);
    return rows.map(accountAdapters.dbToModel);
  },

  findById: async (id) => {
    const rows = await db
      .select()
      .from(accounts)
      .where(ownedWhere(accounts.userId, userId, sql`${accounts.id} = ${id}`))
      .limit(1);
    return rows[0] ? accountAdapters.dbToModel(rows[0]) : null;
  },

  findByName: async (name) => {
    const rows = await db
      .select()
      .from(accounts)
      .where(ownedWhere(accounts.userId, userId, sql`lower(${accounts.name}) = lower(${name})`))
      .limit(1);
    return rows[0] ? accountAdapters.dbToModel(rows[0]) : null;
  },

  findRawById: async (id) => {
    const rows = await db
      .select()
      .from(accounts)
      .where(ownedWhere(accounts.userId, userId, sql`${accounts.id} = ${id}`))
      .limit(1);
    return rows[0] ? accountAdapters.dbToEntity(rows[0]) : null;
  },

  balanceParts: async (accountId) => {
    const [row] = await db.all<{
      income: number;
      expenses: number;
      transfers_out: number;
      transfers_in: number;
    }>(sql`
      SELECT
        COALESCE(SUM(CASE WHEN t.type = ${TransactionType.enum.income}   THEN t.amount ELSE 0 END), 0) AS income,
        COALESCE(SUM(CASE WHEN t.type = ${TransactionType.enum.expense}  THEN t.amount ELSE 0 END), 0) AS expenses,
        COALESCE(SUM(CASE WHEN t.type = ${TransactionType.enum.transfer} THEN t.amount ELSE 0 END), 0) AS transfers_out,
        COALESCE((
          SELECT SUM(t2.amount) FROM transactions t2
          WHERE ${ownedBy(userId, 't2')}
            AND t2.to_account_id = ${accountId}
            AND t2.type = ${TransactionType.enum.transfer}
            AND t2.status = ${TransactionStatus.enum.effective}
        ), 0) AS transfers_in
      FROM transactions t
      WHERE ${ownedBy(userId, 't')}
        AND t.from_account_id = ${accountId}
        AND t.status = ${TransactionStatus.enum.effective}
    `);
    return BalancePartsRow.parse({
      income: row?.income ?? 0,
      expenses: row?.expenses ?? 0,
      transfersIn: row?.transfers_in ?? 0,
      transfersOut: row?.transfers_out ?? 0,
    });
  },

  countReferences: async (accountId) => {
    const [txRow] = await db
      .select({ count: sql<number>`count(*)` })
      .from(transactions)
      .where(
        ownedWhere(
          transactions.userId,
          userId,
          sql`(${transactions.fromAccountId} = ${accountId} OR ${transactions.toAccountId} = ${accountId})`,
        ),
      );
    const [recRow] = await db
      .select({ count: sql<number>`count(*)` })
      .from(recurringRules)
      .where(ownedWhere(recurringRules.userId, userId, eq(recurringRules.accountId, accountId)));
    const [cardRow] = await db
      .select({ count: sql<number>`count(*)` })
      .from(creditCards)
      .where(ownedWhere(creditCards.userId, userId, eq(creditCards.paymentAccountId, accountId)));
    return {
      transactions: txRow?.count ?? 0,
      recurring: recRow?.count ?? 0,
      cards: cardRow?.count ?? 0,
    };
  },
});

/**
 * The account entity's `EntityApplier` — how `runEffects` applies an account `Persistable`
 * without ever naming "account" itself. `accounts` follows the `id`/`version` convention, so this
 * is just `ownedTableApplier(accounts, userId)` — model→row adaptation already happened upstream,
 * before `runEffects` ever sees the batch, so this applier only ever writes the row it's handed.
 */
export const accountApplier = (userId: string): EntityApplier => ownedTableApplier(accounts, userId);
