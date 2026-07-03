import { eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import * as transactionAdapters from '../../../adapters/transactions.js';
import { expectPresent, rowNotFoundAfterWrite } from '../present.js';
import { BillSchema, BillStatus, type Bill } from '../../../models/bill.js';
import type { RawTransactionView } from '../../../models/transaction.js';
import { isBillPaid, type BillPeriod } from '../../../logic/bill.js';
import { BillRowSchema } from '../../../wire/db/bills.js';
import type { Db } from '../driver.js';
import { bills, transactionTags, transactions } from '../schema.js';
import { fullTxSelect } from '../transactionSelect.js';

const toBill = (record: Record<string, unknown>): Bill => {
  const row = BillRowSchema.parse(record);
  return BillSchema.parse({
    id: row.id,
    month: row.month,
    year: row.year,
    closeDate: row.close_date,
    dueDate: row.due_date,
    status: row.status,
    paymentTransactionId: row.payment_transaction_id ?? undefined,
  });
};

const fetchBillById = async (db: Db, billId: string): Promise<Bill | null> => {
  const [row] = await db.all<Record<string, unknown>>(sql`SELECT * FROM bills WHERE id = ${billId}`);
  return row ? toBill(row) : null;
};

// The bill-with-card SELECT also returns the joined card name.
const cardNameOf = (record: Record<string, unknown>): string =>
  z.object({ card_name: z.string() }).parse(record).card_name;

export type BillWithItems = { bill: Bill; cardName: string; transactions: RawTransactionView[] };

export type BillsRepo = {
  /**
   * UPSERT the cycle's bill for a card and attach the transaction, atomically. Refuses to attach
   * onto a bill that is already `paid` (returns null) — the whole check-then-write is one DB
   * transaction, so a concurrent pay_bill can't slip a transaction onto a bill mid-attach.
   */
  ensureAndAttach: (cardId: string, transactionId: string, period: BillPeriod, newId: string) => Promise<Bill | null>;
  get: (cardId: string, month: number, year: number) => Promise<BillWithItems | null>;
  /** Lightweight cycle lookup (no card-name join, no transaction items) — for status checks. */
  findByCycle: (cardId: string, month: number, year: number) => Promise<Bill | null>;
  findById: (billId: string) => Promise<Bill | null>;
  setStatus: (billId: string, status: BillStatus) => Promise<Bill | null>;
  /** Marks the bill paid and links its payment transfer, in one write. */
  markPaid: (billId: string, transactionId: string) => Promise<Bill | null>;
  /** Atomically deletes the payment transfer and flips the bill paid → closed. */
  revertPayment: (billId: string, transactionId: string) => Promise<Bill | null>;
};

export const billsRepo = (db: Db): BillsRepo => ({
  ensureAndAttach: async (cardId, transactionId, period, newId) => {
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
      // above and the attach below, so a concurrent pay_bill can't observe a stale "not yet paid".
      const [rawBill] = await tx.all<Record<string, unknown>>(sql`
        SELECT * FROM bills WHERE credit_card_id = ${cardId} AND month = ${period.month} AND year = ${period.year}
      `);
      const bill = toBill(expectPresent(rawBill, rowNotFoundAfterWrite('bills', 'upsert')));

      if (isBillPaid(bill)) return null;

      // Link the transaction to the bill — verify the row actually existed.
      const result = await tx.update(transactions).set({ billId: bill.id }).where(eq(transactions.id, transactionId));
      if ((result.rowsAffected ?? 0) === 0) {
        throw new Error(`bills: transaction ${transactionId} not found, cannot attach to bill ${bill.id}`);
      }

      return bill;
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
