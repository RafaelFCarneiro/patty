import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../app-builder.js';
import { updateTransaction } from '../../../src/controllers/transaction/movement.js';
import { billPeriodFor } from '../../../src/logic/bill.js';
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

describe('updateTransaction — reassignment attach runs before the main write', () => {
  it('leaves the patched fields untouched when ensureAndAttach blocks on a concurrent paid-bill race', async () => {
    const { deps } = await buildApp({ dbPath: join(tmpDir, 'reassign-atomicity.db') });

    const cardAccountId = randomUUID();
    const card = await deps.creditCards.createWithAccount(
      {
        id: randomUUID(),
        name: 'Atomicity Card',
        currency: 'BRL',
        closingDay: 28,
        dueDay: 5,
        accountId: cardAccountId,
      },
      {
        id: cardAccountId,
        name: 'Card: Atomicity Card',
        type: AccountType.enum.credit,
        currency: 'BRL',
        initialBalance: 0,
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
        idempotencyKey: 'reassign-atomicity-purchase',
        classification: { method: ClassificationMethod.enum.none, confidence: 0 },
        refs: { cardId: card.id },
      },
      [],
    );
    const period = billPeriodFor(date, card.closingDay, card.dueDay);
    const originalBill = await deps.bills.ensureAndAttach(card.id, transaction.id, period, randomUUID());

    // Simulate ensureAndAttach's atomic re-check losing a race to a concurrent pay_bill — it must
    // reject before any other field in this same update request has been written.
    const racedDeps = { ...deps, bills: { ...deps.bills, ensureAndAttach: async () => null } };

    const result = await updateTransaction(racedDeps, {
      id: transaction.id,
      description: 'Changed description',
      amount: 999,
      billMonth: period.month === 12 ? 1 : period.month + 1,
      billYear: period.month === 12 ? period.year + 1 : period.year,
    });

    expect(result.isErr()).toBe(true);
    const error = result._unsafeUnwrapErr();
    expect(error.code).toBe('validation');
    expect(error.issues?.[0]).toContain('revert_bill_payment');

    const persisted = await deps.transactions.getById(transaction.id);
    expect(persisted?.description).toBe('Original description');
    expect(persisted?.amount).toBe(40);
    expect(persisted?.billId).toBe(originalBill?.id);
  });
});
