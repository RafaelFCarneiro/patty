import { eq, sql } from 'drizzle-orm';
import * as accountAdapters from '../../../adapters/accounts.js';
import type { Account, AccountEntity, AccountReferences } from '../../../models/account.js';
import { TransactionStatus, TransactionType } from '../../../models/transaction.js';
import { BalancePartsRow } from '../../../wire/db/accounts.js';
import type { Db } from '../driver.js';
import { accounts, creditCards, recurringRules, transactions } from '../schema.js';
import { versionedTableApplier, type EntityApplier } from '../unitOfWork.js';

export type AccountsRepo = {
  list: () => Promise<Account[]>;
  findById: (id: string) => Promise<Account | null>;
  findByName: (name: string) => Promise<Account | null>;
  /** Version-carrying read (ADR-021) — for flows building an `update`/`delete` `Persistable`. */
  findRawById: (id: string) => Promise<AccountEntity | null>;
  /** Aggregated movement per account: transactions + transfers, both directions. */
  balanceParts: (accountId: string) => Promise<BalancePartsRow>;
  countReferences: (accountId: string) => Promise<AccountReferences>;
};

export const accountsRepo = (db: Db): AccountsRepo => ({
  list: async () => {
    const rows = await db.select().from(accounts).orderBy(accounts.name);
    return rows.map(accountAdapters.dbToModel);
  },

  findById: async (id) => {
    const rows = await db
      .select()
      .from(accounts)
      .where(sql`${accounts.id} = ${id}`)
      .limit(1);
    return rows[0] ? accountAdapters.dbToModel(rows[0]) : null;
  },

  findByName: async (name) => {
    const rows = await db
      .select()
      .from(accounts)
      .where(sql`lower(${accounts.name}) = lower(${name})`)
      .limit(1);
    return rows[0] ? accountAdapters.dbToModel(rows[0]) : null;
  },

  findRawById: async (id) => {
    const rows = await db
      .select()
      .from(accounts)
      .where(sql`${accounts.id} = ${id}`)
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
          WHERE t2.to_account_id = ${accountId}
            AND t2.type = ${TransactionType.enum.transfer}
            AND t2.status = ${TransactionStatus.enum.effective}
        ), 0) AS transfers_in
      FROM transactions t
      WHERE t.from_account_id = ${accountId}
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
      .where(sql`${transactions.fromAccountId} = ${accountId} OR ${transactions.toAccountId} = ${accountId}`);
    const [recRow] = await db
      .select({ count: sql<number>`count(*)` })
      .from(recurringRules)
      .where(eq(recurringRules.accountId, accountId));
    const [cardRow] = await db
      .select({ count: sql<number>`count(*)` })
      .from(creditCards)
      .where(eq(creditCards.paymentAccountId, accountId));
    return {
      transactions: txRow?.count ?? 0,
      recurring: recRow?.count ?? 0,
      cards: cardRow?.count ?? 0,
    };
  },

});

/**
 * The account entity's `EntityApplier` (ADR-021) — how the generic `withUnitOfWork` (`diplomat/db/
 * unitOfWork.ts`) applies an account `Persistable` without that file ever naming "account" itself.
 * Registered under `models/account.ts`'s `ACCOUNT_ENTITY_TAG` at the composition root (`main.ts`).
 * `accounts` follows the `id`/`version` convention every mutable table but `dashboards` does, so
 * this is `versionedTableApplier(accounts)` rather than a hand-written insert/update/delete —
 * there's no account-specific mechanics left to write: the model→row adaptation happens upstream
 * (`adapters/accounts.ts`'s `outcomeToDb`, run by the MCP/REST handler before `unitOfWork` ever
 * sees the batch), so this applier only ever writes the row it's handed.
 */
export const accountApplier: EntityApplier = versionedTableApplier(accounts);
