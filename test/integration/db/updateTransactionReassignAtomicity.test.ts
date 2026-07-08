import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../app-builder.js';
import { updateTransaction } from '../../../src/controllers/transactions.js';
import { billPeriodFor, billPeriodForCycle } from '../../../src/logic/bill.js';
import { AccountType } from '../../../src/models/account.js';
import {
  ClassificationMethod,
  TransactionSource,
  TransactionStatus,
  TransactionType,
} from '../../../src/models/transaction.js';

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'fintrack-reassign-atomicity-'));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('updateTransaction — applyUpdate unit-of-work atomicity (ADR-015)', () => {
  it(
    'rolls back description + amount when the CAS finds the source bill is already paid (move-off direction)',
    async () => {
    const { deps } = await buildApp({ dbPath: join(tmpDir, 'reassign-atomicity-src.db') });

    const cardAccountId = randomUUID();
    const bankAccountId = randomUUID();
    await deps.accounts.create({
      id: bankAccountId,
      name: 'Payment Bank',
      type: AccountType.enum.checking,
      currency: 'BRL',
      initialBalance: 1000,
    });
    const card = await deps.creditCards.createWithAccount(
      {
        id: randomUUID(), name: 'Atomicity Card', currency: 'BRL',
        closingDay: 28, dueDay: 5, accountId: cardAccountId,
      },
      {
        id: cardAccountId, name: 'Card: Atomicity Card',
        type: AccountType.enum.credit, currency: 'BRL', initialBalance: 0,
      },
    );

    const date = '2026-06-15';
    const { transaction } = await deps.transactions.create(
      {
        id: randomUUID(),
        description: 'Original description',
        amount: 40,
        type: TransactionType.enum.expense,
        status: TransactionStatus.enum.effective,
        date,
        currency: 'BRL',
        source: TransactionSource.enum.mcp,
        idempotencyKey: 'reassign-atomicity-src',
        classification: { method: ClassificationMethod.enum.none, confidence: 0 },
        refs: { cardId: card.id },
      },
      [],
    );
    const period = billPeriodFor(date, card.closingDay, card.dueDay);
    const originalBill = await deps.bills.ensureAndAttach(card.id, transaction.id, period, randomUUID());
    expect(originalBill).not.toBeNull();

    // Simulate a concurrent pay_bill landing before the reassignment reaches applyUpdate
    // (the source bill is now paid — the CAS inside applyUpdate must catch this and roll back).
    const paymentTxId = randomUUID();
    await deps.transactions.create(
      {
        id: paymentTxId,
        description: 'Pay bill',
        amount: 40,
        type: TransactionType.enum.transfer,
        status: TransactionStatus.enum.effective,
        date,
        currency: 'BRL',
        source: TransactionSource.enum.mcp,
        idempotencyKey: 'pay-bill-payment',
        classification: { method: ClassificationMethod.enum.none, confidence: 0 },
        refs: { accountId: bankAccountId, toAccountId: card.accountId },
      },
      [],
    );
    await deps.bills.markPaid(originalBill!.id, paymentTxId);

    // Attempt to reassign to the next cycle — the source bill is paid, so applyUpdate must
    // reject and roll back (description + amount + billId must be unchanged).
    const nextPeriod = period.month === 12
      ? billPeriodForCycle(1, period.year + 1, card.closingDay, card.dueDay)
      : billPeriodForCycle(period.month + 1, period.year, card.closingDay, card.dueDay);

    const result = await updateTransaction(deps, {
      id: transaction.id,
      description: 'Changed description',
      amount: 999,
      billMonth: nextPeriod.month,
      billYear: nextPeriod.year,
    });

    expect(result.isErr()).toBe(true);
    const error = result._unsafeUnwrapErr();
    expect(error.code).toBe('validation');
    expect((error as { issues?: string[] }).issues?.[0]).toContain('revert_bill_payment');

    // No partial write: description, amount, and billId must be unchanged.
    const persisted = await deps.transactions.getById(transaction.id);
    expect(persisted?.description).toBe('Original description');
    expect(persisted?.amount).toBe(40);
    expect(persisted?.billId).toBe(originalBill?.id);
  });

  it(
    'rolls back description + amount when the CAS finds the target bill is already paid (move-onto direction)',
    async () => {
    const { deps } = await buildApp({ dbPath: join(tmpDir, 'reassign-atomicity-tgt.db') });

    const cardAccountId = randomUUID();
    const bankAccountId = randomUUID();
    await deps.accounts.create({
      id: bankAccountId,
      name: 'Payment Bank',
      type: AccountType.enum.checking,
      currency: 'BRL',
      initialBalance: 1000,
    });
    const card = await deps.creditCards.createWithAccount(
      {
        id: randomUUID(), name: 'Target Card', currency: 'BRL',
        closingDay: 28, dueDay: 5, accountId: cardAccountId,
      },
      {
        id: cardAccountId, name: 'Card: Target Card',
        type: AccountType.enum.credit, currency: 'BRL', initialBalance: 0,
      },
    );

    const date = '2026-06-15';
    const { transaction } = await deps.transactions.create(
      {
        id: randomUUID(),
        description: 'Original description',
        amount: 40,
        type: TransactionType.enum.expense,
        status: TransactionStatus.enum.effective,
        date,
        currency: 'BRL',
        source: TransactionSource.enum.mcp,
        idempotencyKey: 'reassign-atomicity-tgt',
        classification: { method: ClassificationMethod.enum.none, confidence: 0 },
        refs: { cardId: card.id },
      },
      [],
    );
    const period = billPeriodFor(date, card.closingDay, card.dueDay);
    const originalBill = await deps.bills.ensureAndAttach(card.id, transaction.id, period, randomUUID());
    expect(originalBill).not.toBeNull();

    // Pre-create and pay the TARGET bill cycle so the CAS in applyUpdate must reject it.
    const nextPeriod = period.month === 12
      ? billPeriodForCycle(1, period.year + 1, card.closingDay, card.dueDay)
      : billPeriodForCycle(period.month + 1, period.year, card.closingDay, card.dueDay);

    const dummyTxId = randomUUID();
    await deps.transactions.create(
      {
        id: dummyTxId,
        description: 'Next cycle purchase',
        amount: 10,
        type: TransactionType.enum.expense,
        status: TransactionStatus.enum.effective,
        date: '2026-07-15',
        currency: 'BRL',
        source: TransactionSource.enum.mcp,
        idempotencyKey: 'next-cycle-purchase',
        classification: { method: ClassificationMethod.enum.none, confidence: 0 },
        refs: { cardId: card.id },
      },
      [],
    );
    const nextBill = await deps.bills.ensureAndAttach(card.id, dummyTxId, nextPeriod, randomUUID());
    expect(nextBill).not.toBeNull();

    const paymentTxId = randomUUID();
    await deps.transactions.create(
      {
        id: paymentTxId,
        description: 'Pay next bill',
        amount: 10,
        type: TransactionType.enum.transfer,
        status: TransactionStatus.enum.effective,
        date: '2026-07-20',
        currency: 'BRL',
        source: TransactionSource.enum.mcp,
        idempotencyKey: 'pay-next-bill',
        classification: { method: ClassificationMethod.enum.none, confidence: 0 },
        refs: { accountId: bankAccountId, toAccountId: card.accountId },
      },
      [],
    );
    await deps.bills.markPaid(nextBill!.id, paymentTxId);

    // Attempt to reassign to the (now paid) next cycle — CAS must reject; no partial write.
    const result = await updateTransaction(deps, {
      id: transaction.id,
      description: 'Changed description',
      amount: 999,
      billMonth: nextPeriod.month,
      billYear: nextPeriod.year,
    });

    expect(result.isErr()).toBe(true);
    const error = result._unsafeUnwrapErr();
    expect(error.code).toBe('validation');
    expect((error as { issues?: string[] }).issues?.[0]).toContain('revert_bill_payment');

    // No partial write: description, amount, and billId must be unchanged.
    const persisted = await deps.transactions.getById(transaction.id);
    expect(persisted?.description).toBe('Original description');
    expect(persisted?.amount).toBe(40);
    expect(persisted?.billId).toBe(originalBill?.id);
  });

  it('applyUpdate: returns the applied row when no CAS conflict', async () => {
    const { deps } = await buildApp({ dbPath: join(tmpDir, 'reassign-atomicity-ok.db') });

    const cardAccountId = randomUUID();
    const card = await deps.creditCards.createWithAccount(
      { id: randomUUID(), name: 'Ok Card', currency: 'BRL', closingDay: 28, dueDay: 5, accountId: cardAccountId },
      { id: cardAccountId, name: 'Card: Ok Card', type: AccountType.enum.credit, currency: 'BRL', initialBalance: 0 },
    );

    const date = '2026-06-15';
    const { transaction } = await deps.transactions.create(
      {
        id: randomUUID(),
        description: 'Original',
        amount: 50,
        type: TransactionType.enum.expense,
        status: TransactionStatus.enum.effective,
        date,
        currency: 'BRL',
        source: TransactionSource.enum.mcp,
        idempotencyKey: 'reassign-atomicity-ok',
        classification: { method: ClassificationMethod.enum.none, confidence: 0 },
        refs: { cardId: card.id },
      },
      [],
    );
    const period = billPeriodFor(date, card.closingDay, card.dueDay);
    await deps.bills.ensureAndAttach(card.id, transaction.id, period, randomUUID());

    const nextPeriod = period.month === 12
      ? billPeriodForCycle(1, period.year + 1, card.closingDay, card.dueDay)
      : billPeriodForCycle(period.month + 1, period.year, card.closingDay, card.dueDay);

    const outcome = await deps.transactions.applyUpdate(
      transaction.id,
      {
        patch: { description: 'Updated', amount: 99 },
        refs: { accountId: null, categoryId: null, subCategoryId: undefined, tagNames: null },
        reassignment: { cardId: card.id, period: nextPeriod },
      },
      () => randomUUID(),
    );

    expect(outcome.applied).toBe(true);
    if (!outcome.applied) return; // type narrowing
    expect(outcome.row.description).toBe('Updated');
    expect(outcome.row.amount).toBe(99);
    // The transaction is now attached to the new cycle's bill.
    expect(outcome.row.billId).toBeDefined();

    const newBill = await deps.bills.findByCycle(card.id, nextPeriod.month, nextPeriod.year);
    expect(newBill?.id).toBe(outcome.row.billId);
  });
});
