import { and, eq, sql } from 'drizzle-orm';
import * as accountAdapters from '../../../adapters/accounts.js';
import { expectPresent, rowNotFoundAfterWrite } from '../present.js';
import type { Account, AccountEntity, AccountReferences, AccountType } from '../../../models/account.js';
import type { CurrencyCode } from '../../../models/money.js';
import { TransactionStatus, TransactionType } from '../../../models/transaction.js';
import { BalancePartsRow } from '../../../wire/db/accounts.js';
import type { Db } from '../driver.js';
import { accounts, creditCards, recurringRules, transactions } from '../schema.js';
import { INITIAL_VERSION, type EntityApplier } from '../unitOfWork.js';

export type AccountPatch = {
  name?: string;
  initialBalance?: number;
  type?: AccountType;
  currency?: CurrencyCode;
};

export type AccountsRepo = {
  list: () => Promise<Account[]>;
  create: (account: Account) => Promise<Account>;
  findById: (id: string) => Promise<Account | null>;
  findByName: (name: string) => Promise<Account | null>;
  /** Aggregated movement per account: transactions + transfers, both directions. */
  balanceParts: (accountId: string) => Promise<BalancePartsRow>;
  countReferences: (accountId: string) => Promise<AccountReferences>;
  delete: (accountId: string) => Promise<void>;
  update: (accountId: string, patch: AccountPatch) => Promise<Account>;
};

export const accountsRepo = (db: Db): AccountsRepo => ({
  list: async () => {
    const rows = await db.select().from(accounts).orderBy(accounts.name);
    return rows.map(accountAdapters.dbToModel);
  },

  create: async (account) => {
    const [row] = await db
      .insert(accounts)
      .values({
        id: account.id,
        name: account.name,
        type: account.type,
        initialBalance: account.initialBalance,
        currency: account.currency,
      })
      .returning();
    return accountAdapters.dbToModel(expectPresent(row, rowNotFoundAfterWrite('accounts', 'insert')));
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

  delete: async (accountId) => {
    await db.delete(accounts).where(eq(accounts.id, accountId));
  },

  update: async (accountId, patch) => {
    const values: Record<string, unknown> = {};
    if (patch.name !== undefined) values.name = patch.name;
    if (patch.initialBalance !== undefined) values.initialBalance = patch.initialBalance;
    if (patch.type !== undefined) values.type = patch.type;
    if (patch.currency !== undefined) values.currency = patch.currency;
    if (Object.keys(values).length === 0) {
      const existing = await db.select().from(accounts).where(eq(accounts.id, accountId)).limit(1);
      return accountAdapters.dbToModel(expectPresent(existing[0], 'accounts: row not found'));
    }
    const [row] = await db.update(accounts).set(values).where(eq(accounts.id, accountId)).returning();
    return accountAdapters.dbToModel(expectPresent(row, rowNotFoundAfterWrite('accounts', 'update')));
  },
});

/**
 * The account entity's `EntityApplier` (ADR-021) — how the generic `withUnitOfWork` (`diplomat/db/
 * unitOfWork.ts`) applies an account `Persistable` without that file ever naming "account" itself.
 * Registered under `models/account.ts`'s `ACCOUNT_ENTITY_TAG` at the composition root (`main.ts`).
 * Needs no `db` (every method runs against the `tx` the shell hands it), so it's a plain constant,
 * not a factory.
 */
export const accountApplier: EntityApplier = {
  insert: async (tx, model) => {
    // `model` carries no `version` (models/persistable.ts's insert Persistable is the plain
    // `Account`) — every new row starts at the same structural constant, supplied here.
    const account = model as Account;
    await tx
      .insert(accounts)
      .values(accountAdapters.modelToDb({ ...account, version: INITIAL_VERSION }))
      .onConflictDoNothing();
  },

  update: async (tx, model) => {
    // Drop `id`/`version` from the row and key off `entity` directly instead: drizzle's insert-row
    // type marks a `.default(...)` column optional, but `entity` (an `AccountEntity`) guarantees
    // both are present. The new version is computed here, in application code, from the version
    // the core read (`entity.version`) — never an opaque `version + 1` SQL expression left for the
    // database engine to evaluate.
    const entity = model as AccountEntity;
    const { id: _id, version: _readVersion, ...values } = accountAdapters.modelToDb(entity);
    const result = await tx
      .update(accounts)
      .set({ ...values, version: entity.version + 1 })
      .where(and(eq(accounts.id, entity.id), eq(accounts.version, entity.version)));
    return (result.rowsAffected ?? 0) > 0;
  },

  delete: async (tx, id, version) => {
    const result = await tx.delete(accounts).where(and(eq(accounts.id, id), eq(accounts.version, version)));
    return (result.rowsAffected ?? 0) > 0;
  },
};
