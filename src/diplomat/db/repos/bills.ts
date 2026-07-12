import { and, eq, ne, sql } from 'drizzle-orm';
import { z } from 'zod';
import * as transactionAdapters from '../../../adapters/transactions.js';
import { expectPresent, rowNotFoundAfterWrite } from '../present.js';
import { BillSchema, BillStatus, type Bill } from '../../../models/bill.js';
import type { RawTransactionView, Transaction } from '../../../models/transaction.js';
import { isBillPaid, type BillPeriod } from '../../../logic/bill.js';
import { BillRowSchema } from '../../../wire/db/bills.js';
import type { Db, Executor } from '../driver.js';
import { bills, transactionTags, transactions } from '../schema.js';
import { fullTxSelect } from '../transactionSelect.js';
import { insertTransactionRow } from './transactions.js';

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

const fetchBillById = async (executor: Executor, billId: string): Promise<Bill | null> => {
  const [row] = await executor.all<Record<string, unknown>>(sql`SELECT * FROM bills WHERE id = ${billId}`);
  return row ? toBill(row) : null;
};

// The bill-with-card SELECT also returns the joined card name.
const cardNameOf = (record: Record<string, unknown>): string =>
  z.object({ card_name: z.string() }).parse(record).card_name;

export type BillWithItems = { bill: Bill; cardName: string; transactions: RawTransactionView[] };

/**
 * `pay`'s outcome as data (ADR-018), mirroring `CreateTxResult`'s `created` convention:
 * `alreadyPaid: true` means a concurrent `pay` won the race — the transfer insert deduped on
 * `idempotencyKey` and the status-conditioned UPDATE matched zero rows, so this call did nothing
 * but observe. Either way `bill` is the current, post-write state.
 */
export type PayBillOutcome = { alreadyPaid: boolean; bill: Bill };

export type BillsRepo = {
  /**
   * UPSERT the cycle's bill for a card and attach the transaction, atomically. Refuses (returns
   * null) if the target bill is already `paid`, or — for a reassignment — if the transaction's
   * current bill has independently become `paid` since the controller's pre-check. The whole
   * check-then-write is one DB transaction, so a concurrent pay_bill can't slip a transaction onto
   * or off of a paid bill mid-attach.
   */
  ensureAndAttach: (cardId: string, transactionId: string, period: BillPeriod, newId: string) => Promise<Bill | null>;
  get: (cardId: string, month: number, year: number) => Promise<BillWithItems | null>;
  /** Lightweight cycle lookup (no card-name join, no transaction items) — for status checks. */
  findByCycle: (cardId: string, month: number, year: number) => Promise<Bill | null>;
  findById: (billId: string) => Promise<Bill | null>;
  setStatus: (billId: string, status: BillStatus) => Promise<Bill | null>;
  /**
   * Inserts the payment-transfer transaction and flips the bill to `paid`, in one `db.transaction`
   * (ADR-018): both writes commit or neither does. The status flip is conditioned on the bill's own
   * `status != 'paid'`, so a concurrent `pay` on the same bill is a mechanical no-op — the bill
   * enforcing its own invariant on its own row, not a domain-rule leak. Throws (rolling back the
   * transfer insert too) if `billId` doesn't exist — the caller always hands in an id it just
   * resolved, so this is an invariant violation, not a normal outcome.
   */
  pay: (billId: string, paymentTransfer: Transaction) => Promise<PayBillOutcome>;
  /** Atomically deletes the payment transfer and flips the bill paid → closed. */
  revertPayment: (billId: string, transactionId: string) => Promise<Bill | null>;
};

export const billsRepo = (db: Db): BillsRepo => ({
  ensureAndAttach: async (cardId, transactionId, period, newId) => {
    return db.transaction(async (tx) => {
      // Refuse if the transaction currently belongs to a bill that's already paid — the atomic
      // counterpart to the target-bill check below, closing the same race for the "move off a
      // paid bill" direction during a reassignment (a fresh insert or a self-heal attach has no
      // current bill_id yet, so this is a no-op then).
      const [currentTxRow] = await tx.all<{ bill_id: string | null }>(
        sql`SELECT bill_id FROM transactions WHERE id = ${transactionId}`,
      );
      if (currentTxRow?.bill_id) {
        const [currentBillRow] = await tx.all<Record<string, unknown>>(
          sql`SELECT * FROM bills WHERE id = ${currentTxRow.bill_id}`,
        );
        if (currentBillRow && isBillPaid(toBill(currentBillRow))) return null;
      }

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

  pay: async (billId, paymentTransfer) => {
    return db.transaction(async (tx) => {
      const { transaction } = await insertTransactionRow(tx, paymentTransfer, []);

      const result = await tx
        .update(bills)
        .set({ status: BillStatus.enum.paid, paymentTransactionId: transaction.id })
        .where(and(eq(bills.id, billId), ne(bills.status, BillStatus.enum.paid)));

      // Throwing (not returning null) rolls back the transfer insert above along with it — the
      // caller always hands in an id it just resolved, so a missing bill here is an invariant
      // violation, not a normal outcome to represent as data (unlike alreadyPaid).
      const bill = expectPresent(await fetchBillById(tx, billId), rowNotFoundAfterWrite('bills', 'pay'));

      return { alreadyPaid: (result.rowsAffected ?? 0) === 0, bill };
    });
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
