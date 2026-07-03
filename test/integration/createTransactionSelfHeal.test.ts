import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from './app-builder.js';
import { createTransaction } from '../../src/controllers/transactions.js';
import { billPeriodFor } from '../../src/logic/bill.js';
import { AccountType } from '../../src/models/account.js';
import {
  ClassificationMethod,
  TransactionSource,
  TransactionStatus,
  TransactionType,
} from '../../src/models/transaction.js';

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'fintrack-self-heal-'));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('createTransaction — self-heals a row that was inserted but never attached to a bill', () => {
  it('a replay with the same idempotencyKey attaches the bill instead of staying orphaned', async () => {
    const { deps } = await buildApp({ dbPath: join(tmpDir, 'self-heal.db') });

    const cardAccountId = randomUUID();
    const card = await deps.creditCards.createWithAccount(
      {
        id: randomUUID(),
        name: 'Self Heal Card',
        currency: 'BRL',
        closingDay: 28,
        dueDay: 5,
        accountId: cardAccountId,
      },
      {
        id: cardAccountId,
        name: 'Card: Self Heal Card',
        type: AccountType.enum.credit,
        currency: 'BRL',
        initialBalance: 0,
      },
    );

    const date = '2026-06-15';
    const idempotencyKey = 'self-heal-purchase';

    // Simulate a crash between the insert and the attach: insert the row directly via the repo,
    // bypassing createTransaction's own attach step, so it has a card but no bill.
    const { transaction: inserted } = await deps.transactions.create(
      {
        id: randomUUID(),
        description: 'Self heal purchase',
        amount: 40,
        type: TransactionType.enum.expense,
        status: TransactionStatus.enum.effective,
        date,
        currency: 'BRL',
        source: TransactionSource.enum.mcp,
        idempotencyKey,
        classification: { method: ClassificationMethod.enum.none, confidence: 0 },
        refs: { cardId: card.id },
      },
      [],
    );
    expect(inserted.billId).toBeUndefined();

    // Replay create_transaction with the same idempotencyKey — the row already exists (created:
    // false), but it's still missing its bill, so this should self-heal rather than stay orphaned.
    const result = await createTransaction(
      deps,
      {
        description: 'Self heal purchase',
        amount: 40,
        type: 'expense',
        date,
        card: 'Self Heal Card',
        idempotencyKey,
      },
      TransactionSource.enum.mcp,
    );

    expect(result.isOk()).toBe(true);
    const value = result._unsafeUnwrap();
    expect(value.created).toBe(false);
    expect(value.transaction.billId).toBeDefined();

    // The DB row itself is fixed, not just the response.
    const persisted = await deps.transactions.getById(inserted.id);
    const expectedPeriod = billPeriodFor(date, card.closingDay, card.dueDay);
    const bill = await deps.bills.findByCycle(card.id, expectedPeriod.month, expectedPeriod.year);
    expect(persisted?.billId).toBe(bill?.id);
  });
});
