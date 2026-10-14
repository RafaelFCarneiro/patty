import { sql } from 'drizzle-orm';
import * as R from 'remeda';
import { z } from 'zod';
import * as transactionAdapters from '../../../adapters/transactions.js';
import { RawBillSchema, type Bill, type RawBill } from '../../../models/bill.js';
import type { RawTransactionView } from '../../../models/transaction.js';
import { BillRowSchema } from '../../../wire/db/bills.js';
import type { Db } from '../driver.js';
import { bills } from '../schema.js';
import { isUniqueConstraintViolation } from '../sqliteErrors.js';
import { fullTxSelect } from '../queries/transactionSelect.js';
import { VersionConflict, ownedTableApplier, type EntityApplier } from '../effects.js';
import { ownedBy } from '../queries/scope.js';

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

const fetchBillRow = async (db: Db, userId: string, billId: string): Promise<Record<string, unknown> | undefined> => {
  const [row] = await db.all<Record<string, unknown>>(
    sql`SELECT * FROM bills WHERE ${ownedBy(userId)} AND id = ${billId}`,
  );
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
  /** Every bill ever opened for a card, version-carrying — `deleteCreditCard` decides which of
   *  these to remove (and which need `paymentTransactionId` cleared first) as its own
   *  `Persistable`s. */
  findAllByCard: (cardId: string) => Promise<RawBill[]>;
};

export const billsRepo = (db: Db, userId: string): BillsRepo => ({
  get: async (cardId, month, year) => {
    const [billRow] = await db.all<Record<string, unknown>>(sql`
      SELECT b.*, cc.name AS card_name
      FROM bills b JOIN credit_cards cc ON cc.id = b.credit_card_id
      WHERE ${ownedBy(userId, 'b')} AND b.credit_card_id = ${cardId} AND b.month = ${month} AND b.year = ${year}
    `);
    if (!billRow) return null;
    const bill = toBill(billRow);

    const txRows = await db.all<Record<string, unknown>>(sql`
      ${fullTxSelect(userId, sql`t.bill_id = ${bill.id}`)}
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
      SELECT * FROM bills WHERE ${ownedBy(userId)} AND credit_card_id = ${cardId} AND month = ${month} AND year = ${year}
    `);
    return row ? toRawBill(row) : null;
  },

  findById: async (billId) => {
    const row = await fetchBillRow(db, userId, billId);
    return row ? toRawBill(row) : null;
  },

  findAllByCard: async (cardId) => {
    const rows = await db.all<Record<string, unknown>>(
      sql`SELECT * FROM bills WHERE ${ownedBy(userId)} AND credit_card_id = ${cardId}`,
    );
    return rows.map(toRawBill);
  },
});

const versionedBillApplier = (userId: string): EntityApplier => ownedTableApplier(bills, userId);

/** A bill is created by cycle (`UNIQUE(creditCardId, month, year)`), not by `id`, so a concurrent
 *  first purchase on the same cycle can raise a real unique-constraint error that
 *  `versionedTableApplier`'s id-scoped `onConflictDoNothing` doesn't swallow. Rethrown as
 *  `VersionConflict` to roll back and retry the flow instead of surfacing a raw 500 or a
 *  wrong-id no-op. `update`/`delete` stay plain. */
export const billApplier = (userId: string): EntityApplier => {
  const applier = versionedBillApplier(userId);
  return {
    ...applier,
    insert: async (tx, model) => {
      try {
        return await applier.insert(tx, model);
      } catch (cause) {
        if (isUniqueConstraintViolation(cause)) throw new VersionConflict();
        throw cause;
      }
    },
  };
};
