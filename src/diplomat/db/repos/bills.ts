import { eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import * as transactionAdapters from '../../../adapters/transactions.js';
import { expectPresent, rowNotFoundAfterWrite } from '../present.js';
import { BillStatus, RawBillSchema, type Bill, type RawBill } from '../../../models/bill.js';
import type { RawTransactionView } from '../../../models/transaction.js';
import type { BillPeriod } from '../../../logic/bill.js';
import { BillRowSchema } from '../../../wire/db/bills.js';
import type { Db } from '../driver.js';
import { bills, transactionTags, transactions } from '../schema.js';
import { fullTxSelect } from '../transactionSelect.js';
import { VersionConflict, versionedTableApplier, type EntityApplier } from '../unitOfWork.js';

const toBill = (record: Record<string, unknown>): RawBill => {
  const row = BillRowSchema.parse(record);
  return RawBillSchema.parse({
    id: row.id,
    creditCardId: row.credit_card_id,
    month: row.month,
    year: row.year,
    closeDate: row.close_date,
    dueDate: row.due_date,
    status: row.status,
    paymentTransactionId: row.payment_transaction_id ?? undefined,
    version: row.version,
  });
};

const fetchBillById = async (db: Db, billId: string): Promise<RawBill | null> => {
  const [row] = await db.all<Record<string, unknown>>(sql`SELECT * FROM bills WHERE id = ${billId}`);
  return row ? toBill(row) : null;
};

// The bill-with-card SELECT also returns the joined card name.
const cardNameOf = (record: Record<string, unknown>): string =>
  z.object({ card_name: z.string() }).parse(record).card_name;

export type BillWithItems = { bill: Bill; cardName: string; transactions: RawTransactionView[] };

export type BillsRepo = {
  get: (cardId: string, month: number, year: number) => Promise<BillWithItems | null>;
  /** Lightweight cycle lookup (no card-name join, no transaction items) — for status checks and
   *  for the credit-card aggregate's own FC/IS read-decide step (ADR-021 phase 2b), hence the
   *  `version`-carrying `RawBill` (needed to build a version-guarded `Persistable`). */
  findByCycle: (cardId: string, month: number, year: number) => Promise<RawBill | null>;
  findById: (billId: string) => Promise<RawBill | null>;
  /**
   * Idempotent upsert-by-cycle: creates the cycle's bill `open` if none exists yet, or returns the
   * existing one — pure persistence mechanics only (no paid-guard, no transaction attach; those are
   * the caller's own decision, never the repo's). Used only by the still-repo-driven bulk-import
   * legacy path (`addCardPurchaseViaRepo` in `controllers/creditCard/transaction.ts`, pending its
   * own ADR-021 phase 3 conversion) — the FC/IS `addCardPurchase` expresses the same
   * create-or-reference decision as a `Persistable` instead (`billApplier`, below), never through
   * this method.
   */
  ensureOpen: (cardId: string, period: BillPeriod, newId: string) => Promise<Bill>;
  setStatus: (billId: string, status: BillStatus) => Promise<Bill | null>;
  /** Marks the bill paid and links its payment transfer, in one write. */
  markPaid: (billId: string, transactionId: string) => Promise<Bill | null>;
  /** Atomically deletes the payment transfer and flips the bill paid → closed. */
  revertPayment: (billId: string, transactionId: string) => Promise<Bill | null>;
};

export const billsRepo = (db: Db): BillsRepo => ({
  ensureOpen: async (cardId, period, newId) => {
    return db.transaction(async (tx) => {
      await tx
        .insert(bills)
        .values({
          id: newId,
          creditCardId: cardId,
          month: period.month,
          year: period.year,
          closeDate: period.closeDate,
          dueDate: period.dueDate,
          status: BillStatus.enum.open,
        })
        .onConflictDoNothing({ target: [bills.creditCardId, bills.month, bills.year] });

      // Resolve the bill id (may have been the pre-existing one) — same transaction as the insert
      // above, so a concurrent insert of the same cycle can't produce two rows.
      const [rawBill] = await tx.all<Record<string, unknown>>(sql`
        SELECT * FROM bills WHERE credit_card_id = ${cardId} AND month = ${period.month} AND year = ${period.year}
      `);
      return toBill(expectPresent(rawBill, rowNotFoundAfterWrite('bills', 'upsert')));
    });
  },

  get: async (cardId, month, year) => {
    const [billRow] = await db.all<Record<string, unknown>>(sql`
      SELECT b.*, cc.name AS card_name
      FROM bills b JOIN credit_cards cc ON cc.id = b.credit_card_id
      WHERE b.credit_card_id = ${cardId} AND b.month = ${month} AND b.year = ${year}
    `);
    if (!billRow) return null;
    const bill = toBill(billRow);

    const txRows = await db.all<Record<string, unknown>>(sql`
      ${fullTxSelect(sql`t.bill_id = ${bill.id}`)}
      ORDER BY t.date
    `);
    return {
      bill,
      cardName: cardNameOf(billRow),
      transactions: txRows.map(transactionAdapters.dbToModel),
    };
  },

  findByCycle: async (cardId, month, year) => {
    const [row] = await db.all<Record<string, unknown>>(sql`
      SELECT * FROM bills WHERE credit_card_id = ${cardId} AND month = ${month} AND year = ${year}
    `);
    return row ? toBill(row) : null;
  },

  findById: (billId) => fetchBillById(db, billId),

  setStatus: async (billId, status) => {
    await db.update(bills).set({ status }).where(eq(bills.id, billId));
    return fetchBillById(db, billId);
  },

  markPaid: async (billId, transactionId) => {
    await db
      .update(bills)
      .set({ status: BillStatus.enum.paid, paymentTransactionId: transactionId })
      .where(eq(bills.id, billId));
    return fetchBillById(db, billId);
  },

  revertPayment: async (billId, transactionId) => {
    await db.transaction(async (tx) => {
      // FK-safe order: clear the bill's reference to the transaction first (bills.payment_transaction_id
      // → transactions.id would otherwise block deleting the row it still points to), then tags → transaction.
      await tx
        .update(bills)
        .set({ status: BillStatus.enum.closed, paymentTransactionId: null })
        .where(eq(bills.id, billId));
      await tx.delete(transactionTags).where(eq(transactionTags.transactionId, transactionId));
      await tx.delete(transactions).where(eq(transactions.id, transactionId));
    });
    return fetchBillById(db, billId);
  },
});

// bills' one non-`id` uniqueness rule (`schema.ts`'s `bills_card_month_year` index) — the substring
// SQLite's own constraint-violation message names the offending columns with, used below to
// recognize a concurrent bill-creation race on the same cycle (not just any DB error).
const BILL_CYCLE_UNIQUE_CONSTRAINT = 'bills.credit_card_id, bills.month, bills.year';

const isBillCycleUniqueConflict = (cause: unknown): boolean => {
  const driverCause = cause instanceof Error ? cause.cause : undefined;
  return driverCause instanceof Error && driverCause.message.includes(BILL_CYCLE_UNIQUE_CONSTRAINT);
};

const versionedBillApplier = versionedTableApplier(bills);

/**
 * The bill entity's `EntityApplier` (ADR-021 phase 2b): `update`/`delete` follow the plain
 * `id`/`version` convention verbatim (`versionedTableApplier`) — but `insert` doesn't, because a
 * bill isn't created by `id`, it's upserted by cycle (`UNIQUE(creditCardId, month, year)`,
 * `schema.ts`). The domain (`addCardPurchase`) mints a speculative id for what it believes is a
 * brand-new cycle, but a concurrent first purchase on the same cycle can race it — two inserts,
 * different ids, same cycle. `versionedTableApplier`'s own `onConflictDoNothing` is scoped to the
 * `id` target only, so it does NOT swallow that race; the DB raises a genuine unique-constraint
 * error instead. Rather than letting that surface as an opaque 500, or silently no-op-ing it as if
 * it were an id-scoped idempotent retry (which would leave the loser's speculative bill id
 * referenced by nothing), this applier recognizes exactly that one violation and rethrows it as the
 * shell's own `VersionConflict` — the whole unit-of-work batch rolls back and `withUnitOfWork`
 * re-invokes the domain flow (rule 4): a fresh read of `findByCycle` now sees the winner's row and
 * the domain emits a version-guarded *touch* of it instead of an insert. Any other error (a genuine
 * failure) still propagates unchanged. Never a paid/bill-policy decision — that stays the domain's.
 */
export const billApplier: EntityApplier = {
  ...versionedBillApplier,
  insert: async (tx, model) => {
    try {
      return await versionedBillApplier.insert(tx, model);
    } catch (cause) {
      if (isBillCycleUniqueConflict(cause)) throw new VersionConflict();
      throw cause;
    }
  },
};
