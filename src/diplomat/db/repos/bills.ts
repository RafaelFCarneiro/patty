import { sql } from 'drizzle-orm';
import * as R from 'remeda';
import { z } from 'zod';
import * as transactionAdapters from '../../../adapters/transactions.js';
import { expectPresent, rowNotFoundAfterWrite } from '../present.js';
import { BillStatus, RawBillSchema, type Bill, type RawBill } from '../../../models/bill.js';
import type { RawTransactionView } from '../../../models/transaction.js';
import type { BillPeriod } from '../../../logic/bill.js';
import { BillRowSchema } from '../../../wire/db/bills.js';
import type { Db } from '../driver.js';
import { bills } from '../schema.js';
import { isUniqueConstraintViolation } from '../sqliteErrors.js';
import { fullTxSelect } from '../transactionSelect.js';
import { VersionConflict, versionedTableApplier, type EntityApplier } from '../unitOfWork.js';

/** Includes `creditCardId`/`version` — for the FC/IS credit-card transaction flows' own
 *  read-decide step, which needs them to build a `Persistable`. Every other caller uses `toBill`
 *  (below), which never lets those internal fields exist on the returned object in the first
 *  place — there is no wire/out zod parsing on the bill read paths to strip them later. */
const toRawBill = (record: Record<string, unknown>): RawBill => {
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

const toBill = (record: Record<string, unknown>): Bill => R.omit(toRawBill(record), ['creditCardId', 'version']);

const fetchBillRow = async (db: Db, billId: string): Promise<Record<string, unknown> | undefined> => {
  const [row] = await db.all<Record<string, unknown>>(sql`SELECT * FROM bills WHERE id = ${billId}`);
  return row;
};

// The bill-with-card SELECT also returns the joined card name.
const cardNameOf = (record: Record<string, unknown>): string =>
  z.object({ card_name: z.string() }).parse(record).card_name;

export type BillWithItems = { bill: Bill; cardName: string; transactions: RawTransactionView[] };

export type BillsRepo = {
  get: (cardId: string, month: number, year: number) => Promise<BillWithItems | null>;
  /** Lightweight cycle lookup (no card-name join, no transaction items). */
  findByCycle: (cardId: string, month: number, year: number) => Promise<RawBill | null>;
  findById: (billId: string) => Promise<RawBill | null>;
  /** Every bill ever opened for a card. Version-carrying (ADR-021) — for `deleteCreditCard`, which
   *  decides which of these to remove (and which need `paymentTransactionId` cleared first) as its
   *  own `Persistable`s, rather than leaving that decision to a repo-side cascade. */
  findAllByCard: (cardId: string) => Promise<RawBill[]>;
  /** Idempotent upsert-by-cycle: creates the cycle's bill `open` if none exists yet, else returns
   *  the existing one. Used only by the still-repo-driven bulk-import path; the FC/IS
   *  `addCardPurchase` expresses the same decision as a `Persistable` via `billApplier` instead. */
  ensureOpen: (cardId: string, period: BillPeriod, newId: string) => Promise<Bill>;
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
    return row ? toRawBill(row) : null;
  },

  findById: async (billId) => {
    const row = await fetchBillRow(db, billId);
    return row ? toRawBill(row) : null;
  },

  findAllByCard: async (cardId) => {
    const rows = await db.all<Record<string, unknown>>(sql`SELECT * FROM bills WHERE credit_card_id = ${cardId}`);
    return rows.map(toRawBill);
  },
});

const versionedBillApplier = versionedTableApplier(bills);

/** A bill is created by cycle (`UNIQUE(creditCardId, month, year)`), not by `id`, so a concurrent
 *  first purchase on the same cycle can raise a genuine unique-constraint error that
 *  `versionedTableApplier`'s id-scoped `onConflictDoNothing` doesn't swallow — the table's only
 *  other unique constraint, so `isUniqueConstraintViolation` needs no per-constraint disambiguation
 *  here. Recognizing that one violation and rethrowing it as `VersionConflict` rolls the batch back
 *  and retries the flow (rule 4) instead of surfacing a raw 500 or a wrong-id no-op. `update`/
 *  `delete` are plain `versionedTableApplier`. */
export const billApplier: EntityApplier = {
  ...versionedBillApplier,
  insert: async (tx, model) => {
    try {
      return await versionedBillApplier.insert(tx, model);
    } catch (cause) {
      if (isUniqueConstraintViolation(cause)) throw new VersionConflict();
      throw cause;
    }
  },
};
