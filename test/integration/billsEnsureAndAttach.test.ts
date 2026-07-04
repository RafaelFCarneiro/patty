import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { McpTransport } from '../../src/config.js';
import { bootstrap } from '../../src/diplomat/db/bootstrap.js';
import { openDatabase } from '../../src/diplomat/db/driver.js';
import { accountsRepo } from '../../src/diplomat/db/repos/accounts.js';
import { billsRepo } from '../../src/diplomat/db/repos/bills.js';
import { creditCardsRepo } from '../../src/diplomat/db/repos/creditCards.js';
import { transactionsRepo } from '../../src/diplomat/db/repos/transactions.js';
import { billPeriodFor } from '../../src/logic/bill.js';
import { AccountType } from '../../src/models/account.js';
import { CurrencyCode } from '../../src/models/money.js';
import {
  ClassificationMethod,
  TransactionSource,
  TransactionStatus,
  TransactionType,
} from '../../src/models/transaction.js';

const TEST_KEY = 'f'.repeat(64);

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'fintrack-ensure-attach-'));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('bills.ensureAndAttach — atomic paid-bill guard', () => {
  it('refuses to attach a transaction onto a bill that is already paid, without touching it', async () => {
    const db = openDatabase({
      DB_PATH: join(tmpDir, 'ensure-attach.db'),
      FINTRACK_DB_KEY: TEST_KEY,
      PORT: 0,
      MCP_TRANSPORT: McpTransport.enum.http,
    });
    await bootstrap(db);

    const accounts = accountsRepo(db);
    const creditCards = creditCardsRepo(db);
    const bills = billsRepo(db);
    const transactions = transactionsRepo(db);

    const bank = await accounts.create({
      id: randomUUID(),
      name: 'Test Bank',
      type: AccountType.enum.checking,
      currency: CurrencyCode.enum.BRL,
      initialBalance: 1000,
    });

    const cardAccountId = randomUUID();
    const card = await creditCards.createWithAccount(
      {
        id: randomUUID(),
        name: 'Test Card',
        currency: CurrencyCode.enum.BRL,
        closingDay: 28,
        dueDay: 5,
        accountId: cardAccountId,
      },
      {
        id: cardAccountId,
        name: 'Card: Test',
        type: AccountType.enum.credit,
        currency: CurrencyCode.enum.BRL,
        initialBalance: 0,
      },
    );

    const period = billPeriodFor('2026-06-15', card.closingDay, card.dueDay);

    // A purchase attaches to the (open) cycle bill normally.
    const purchaseId = randomUUID();
    await transactions.create(
      {
        id: purchaseId,
        description: 'purchase',
        amount: 100,
        type: TransactionType.enum.expense,
        status: TransactionStatus.enum.effective,
        date: '2026-06-15',
        currency: CurrencyCode.enum.BRL,
        source: TransactionSource.enum.mcp,
        idempotencyKey: 'ensure-attach-purchase',
        classification: { method: ClassificationMethod.enum.none, confidence: 0 },
        refs: { cardId: card.id },
      },
      [],
    );
    const bill = await bills.ensureAndAttach(card.id, purchaseId, period, randomUUID());
    expect(bill).not.toBeNull();

    // Pay it (a real payment transfer, linked via markPaid — mirrors payBill's own writes).
    const transferId = randomUUID();
    await transactions.create(
      {
        id: transferId,
        description: 'payment',
        amount: 100,
        type: TransactionType.enum.transfer,
        status: TransactionStatus.enum.effective,
        date: '2026-06-20',
        currency: CurrencyCode.enum.BRL,
        source: TransactionSource.enum.mcp,
        idempotencyKey: 'ensure-attach-payment',
        classification: { method: ClassificationMethod.enum.none, confidence: 0 },
        refs: { accountId: bank.id, toAccountId: cardAccountId, billId: bill!.id },
      },
      [],
    );
    await bills.markPaid(bill!.id, transferId);

    // A second, late-arriving purchase tries to attach to the now-paid cycle directly at the repo
    // level (bypassing the controller's own pre-check) — this is the atomic guard's job to refuse.
    const latePurchaseId = randomUUID();
    await transactions.create(
      {
        id: latePurchaseId,
        description: 'late purchase',
        amount: 20,
        type: TransactionType.enum.expense,
        status: TransactionStatus.enum.effective,
        date: '2026-06-15',
        currency: CurrencyCode.enum.BRL,
        source: TransactionSource.enum.mcp,
        idempotencyKey: 'ensure-attach-late-purchase',
        classification: { method: ClassificationMethod.enum.none, confidence: 0 },
        refs: { cardId: card.id },
      },
      [],
    );

    const blocked = await bills.ensureAndAttach(card.id, latePurchaseId, period, randomUUID());
    expect(blocked).toBeNull();

    const latePurchase = await transactions.getById(latePurchaseId);
    expect(latePurchase?.billId).toBeUndefined();
  });

  it('refuses to reassign a transaction off a bill that has since become paid, even onto an open target', async () => {
    const db = openDatabase({
      DB_PATH: join(tmpDir, 'ensure-attach-reassign.db'),
      FINTRACK_DB_KEY: TEST_KEY,
      PORT: 0,
      MCP_TRANSPORT: McpTransport.enum.http,
    });
    await bootstrap(db);

    const accounts = accountsRepo(db);
    const creditCards = creditCardsRepo(db);
    const bills = billsRepo(db);
    const transactions = transactionsRepo(db);

    const bank = await accounts.create({
      id: randomUUID(),
      name: 'Test Bank',
      type: AccountType.enum.checking,
      currency: CurrencyCode.enum.BRL,
      initialBalance: 1000,
    });

    const cardAccountId = randomUUID();
    const card = await creditCards.createWithAccount(
      {
        id: randomUUID(),
        name: 'Test Card',
        currency: CurrencyCode.enum.BRL,
        closingDay: 28,
        dueDay: 5,
        accountId: cardAccountId,
      },
      {
        id: cardAccountId,
        name: 'Card: Test',
        type: AccountType.enum.credit,
        currency: CurrencyCode.enum.BRL,
        initialBalance: 0,
      },
    );

    const periodA = billPeriodFor('2026-06-15', card.closingDay, card.dueDay);
    const periodB = billPeriodFor('2026-07-15', card.closingDay, card.dueDay);

    // Attach a purchase to cycle A, then pay it off (cycle A becomes paid).
    const purchaseId = randomUUID();
    await transactions.create(
      {
        id: purchaseId,
        description: 'purchase',
        amount: 100,
        type: TransactionType.enum.expense,
        status: TransactionStatus.enum.effective,
        date: '2026-06-15',
        currency: CurrencyCode.enum.BRL,
        source: TransactionSource.enum.mcp,
        idempotencyKey: 'ensure-attach-reassign-purchase',
        classification: { method: ClassificationMethod.enum.none, confidence: 0 },
        refs: { cardId: card.id },
      },
      [],
    );
    const billA = await bills.ensureAndAttach(card.id, purchaseId, periodA, randomUUID());
    expect(billA).not.toBeNull();

    const transferId = randomUUID();
    await transactions.create(
      {
        id: transferId,
        description: 'payment',
        amount: 100,
        type: TransactionType.enum.transfer,
        status: TransactionStatus.enum.effective,
        date: '2026-06-20',
        currency: CurrencyCode.enum.BRL,
        source: TransactionSource.enum.mcp,
        idempotencyKey: 'ensure-attach-reassign-payment',
        classification: { method: ClassificationMethod.enum.none, confidence: 0 },
        refs: { accountId: bank.id, toAccountId: cardAccountId, billId: billA!.id },
      },
      [],
    );
    await bills.markPaid(billA!.id, transferId);

    // Cycle A (the purchase's current bill) is paid; cycle B is a perfectly open target on its
    // own. Trying to move the purchase from A to B must still be refused, atomically, because the
    // transaction's *current* bill is paid — not because the target is.
    const blocked = await bills.ensureAndAttach(card.id, purchaseId, periodB, randomUUID());
    expect(blocked).toBeNull();

    const stillOnA = await transactions.getById(purchaseId);
    expect(stillOnA?.billId).toBe(billA!.id);

    // Cycle B was never even created as a side effect of the attempt.
    const billB = await bills.findByCycle(card.id, periodB.month, periodB.year);
    expect(billB).toBeNull();
  });
});
