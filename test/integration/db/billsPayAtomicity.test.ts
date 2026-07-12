import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../app-builder.js';
import { billPeriodFor } from '../../../src/logic/bill.js';
import { AccountType } from '../../../src/models/account.js';
import { CurrencyCode } from '../../../src/models/money.js';
import {
  ClassificationMethod,
  TransactionSource,
  TransactionStatus,
  TransactionType,
} from '../../../src/models/transaction.js';

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'fintrack-bills-pay-atomicity-'));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('bills.pay — atomic transfer insert + status flip (ADR-018)', () => {
  // The local libsql driver serializes `db.transaction()` on its single connection (no
  // `busy_timeout` configured) rather than interleaving concurrent callers, so a literal
  // `Promise.all` here just races on SQLITE_BUSY instead of exercising the guard. Two direct,
  // sequential `bills.pay` calls on the same bill reproduce the exact race outcome the atomic
  // status-conditioned UPDATE exists for — a concurrent second caller whose own pre-check read the
  // bill before either write landed — deterministically: same billId, same `billpay-<billId>`
  // idempotency key, different draft id per call (mirroring `deps.newId()` being called fresh by
  // each racing `payBill` invocation).
  it('two racing bills.pay calls on the same bill yield exactly one payment transfer and one paid flip', async () => {
    const { deps } = await buildApp({ dbPath: join(tmpDir, 'pay-atomicity-concurrent.db') });

    const bank = await deps.accounts.create({
      id: randomUUID(),
      name: 'Pay Atomicity Bank',
      type: AccountType.enum.checking,
      currency: CurrencyCode.enum.BRL,
      initialBalance: 1000,
    });

    const cardAccountId = randomUUID();
    const card = await deps.creditCards.createWithAccount(
      {
        id: randomUUID(),
        name: 'Pay Atomicity Card',
        currency: CurrencyCode.enum.BRL,
        closingDay: 28,
        dueDay: 5,
        accountId: cardAccountId,
        paymentAccountId: bank.id,
      },
      {
        id: cardAccountId,
        name: 'Card: Pay Atomicity Card',
        type: AccountType.enum.credit,
        currency: CurrencyCode.enum.BRL,
        initialBalance: 0,
      },
    );

    const date = '2026-06-15';
    const { transaction: purchase } = await deps.transactions.create(
      {
        id: randomUUID(),
        description: 'purchase',
        amount: 150,
        type: TransactionType.enum.expense,
        status: TransactionStatus.enum.effective,
        date,
        currency: CurrencyCode.enum.BRL,
        source: TransactionSource.enum.mcp,
        idempotencyKey: 'pay-atomicity-purchase',
        classification: { method: ClassificationMethod.enum.none, confidence: 0 },
        refs: { accountId: card.accountId, cardId: card.id },
      },
      [],
    );
    const period = billPeriodFor(date, card.closingDay, card.dueDay);
    const bill = await deps.bills.ensureAndAttach(card.id, purchase.id, period, randomUUID());

    const draftFor = (id: string) => ({
      id,
      description: `Bill payment: ${card.name}`,
      amount: 150,
      type: TransactionType.enum.transfer,
      status: TransactionStatus.enum.effective,
      date,
      currency: CurrencyCode.enum.BRL,
      source: TransactionSource.enum.mcp,
      idempotencyKey: `billpay-${bill!.id}`,
      classification: { method: ClassificationMethod.enum.none, confidence: 0 },
      refs: { accountId: bank.id, toAccountId: card.accountId, billId: bill!.id },
    });

    const firstDraftId = randomUUID();
    const first = await deps.bills.pay(bill!.id, draftFor(firstDraftId));
    const second = await deps.bills.pay(bill!.id, draftFor(randomUUID()));

    expect(first.alreadyPaid).toBe(false);
    expect(second.alreadyPaid).toBe(true);
    expect(first.bill.status).toBe('paid');
    expect(second.bill.status).toBe('paid');
    // Both calls resolve to the SAME payment transfer — the first caller's insert — not the
    // second draft's id: the second insert deduped on the shared idempotency key.
    expect(first.bill.paymentTransactionId).toBe(firstDraftId);
    expect(second.bill.paymentTransactionId).toBe(firstDraftId);

    // Exactly one payment transfer was persisted for this bill.
    const billWithItems = await deps.bills.get(card.id, period.month, period.year);
    const billTransfers = billWithItems!.transactions.filter((tx) => tx.type === TransactionType.enum.transfer);
    expect(billTransfers).toHaveLength(1);
    expect(billTransfers[0]?.id).toBe(firstDraftId);
  });

  it('a failed write inside the transaction rolls back — no orphan transfer, bill stays unpaid', async () => {
    const { deps } = await buildApp({ dbPath: join(tmpDir, 'pay-atomicity-rollback.db') });

    const cardAccountId = randomUUID();
    const card = await deps.creditCards.createWithAccount(
      {
        id: randomUUID(),
        name: 'Rollback Card',
        currency: CurrencyCode.enum.BRL,
        closingDay: 28,
        dueDay: 5,
        accountId: cardAccountId,
      },
      {
        id: cardAccountId,
        name: 'Card: Rollback Card',
        type: AccountType.enum.credit,
        currency: CurrencyCode.enum.BRL,
        initialBalance: 0,
      },
    );

    const date = '2026-06-15';
    // A pre-existing row occupies the id the "payment" insert below will collide on — a genuine SQL
    // failure (primary-key violation, not the idempotency-key dedup path), forcing the whole
    // `db.transaction` in `bills.pay` to reject and roll back.
    const collidingId = randomUUID();
    const { transaction: purchase } = await deps.transactions.create(
      {
        id: collidingId,
        description: 'purchase',
        amount: 80,
        type: TransactionType.enum.expense,
        status: TransactionStatus.enum.effective,
        date,
        currency: CurrencyCode.enum.BRL,
        source: TransactionSource.enum.mcp,
        idempotencyKey: 'pay-atomicity-rollback-purchase',
        classification: { method: ClassificationMethod.enum.none, confidence: 0 },
        refs: { accountId: card.accountId, cardId: card.id },
      },
      [],
    );
    const period = billPeriodFor(date, card.closingDay, card.dueDay);
    const bill = await deps.bills.ensureAndAttach(card.id, purchase.id, period, randomUUID());

    await expect(
      deps.bills.pay(bill!.id, {
        id: collidingId,
        description: 'payment',
        amount: 80,
        type: TransactionType.enum.transfer,
        status: TransactionStatus.enum.effective,
        date,
        currency: CurrencyCode.enum.BRL,
        source: TransactionSource.enum.mcp,
        idempotencyKey: 'pay-atomicity-rollback-payment',
        classification: { method: ClassificationMethod.enum.none, confidence: 0 },
        refs: { accountId: card.accountId, toAccountId: card.accountId, billId: bill!.id },
      }),
    ).rejects.toThrow();

    // Rolled back: the bill is still unpaid, and no second transaction exists under the payment's
    // own idempotency key (only the original purchase, unaffected).
    const afterRollback = await deps.bills.findById(bill!.id);
    expect(afterRollback?.status).not.toBe('paid');
    expect(afterRollback?.paymentTransactionId).toBeUndefined();

    const billWithItems = await deps.bills.get(card.id, period.month, period.year);
    const billTransfers = billWithItems!.transactions.filter((tx) => tx.type === TransactionType.enum.transfer);
    expect(billTransfers).toHaveLength(0);
  });
});
