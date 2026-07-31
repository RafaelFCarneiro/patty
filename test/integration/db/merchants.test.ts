import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { McpTransport } from '../../../src/config.js';
import { bootstrap } from '../../../src/diplomat/db/bootstrap.js';
import type { Db } from '../../../src/diplomat/db/driver.js';
import { openDatabase } from '../../../src/diplomat/db/driver.js';
import { merchantsRepo, type MerchantsRepo } from '../../../src/diplomat/db/repos/merchants.js';
import { categories, merchants, transactions } from '../../../src/diplomat/db/schema.js';
import { CategoryKind } from '../../../src/models/category.js';
import {
  ClassificationMethod,
  TransactionSource,
  TransactionStatus,
  TransactionType,
} from '../../../src/models/transaction.js';

const TEST_KEY = 'e'.repeat(64);

let tmpDir: string;
let db: Db;
let repo: MerchantsRepo;

beforeEach(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), 'fintrack-merchants-top-'));
  db = await openDatabase({
    DB_PATH: join(tmpDir, 'merchants-top.db'),
    FINTRACK_DB_KEY: TEST_KEY,
    PORT: 0,
    MCP_TRANSPORT: McpTransport.enum.http,
    FINTRACK_HTTP: true,
  });
  await bootstrap(db);
  repo = merchantsRepo(db);
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

const insertMerchant = async (key: string): Promise<void> => {
  await db.insert(merchants).values({ key }).onConflictDoNothing();
};

const insertCategory = async (name: string): Promise<string> => {
  const id = randomUUID();
  await db
    .insert(categories)
    .values({ id, name, kind: CategoryKind.enum.expense, parentId: null, names: null, version: 0 });
  return id;
};

type TxOverrides = {
  merchantKey?: string | null;
  categoryId?: string | null;
  type?: (typeof TransactionType.options)[number];
  status?: (typeof TransactionStatus.options)[number];
};

/** Inserts a minimal effective/expense transaction row directly (raw drizzle) — test fixture
 *  setup only, never the code under test. Only the columns `merchants.top`'s query reads/filters
 *  on are meaningful here; the rest are structurally required NOT NULLs. */
const insertTx = async ({
  merchantKey = null,
  categoryId = null,
  type = TransactionType.enum.expense,
  status = TransactionStatus.enum.effective,
}: TxOverrides): Promise<void> => {
  await db.insert(transactions).values({
    id: randomUUID(),
    description: 'test transaction',
    amount: 10,
    type,
    status,
    date: '2026-01-01',
    currency: 'BRL',
    source: TransactionSource.enum.mcp,
    idempotencyKey: randomUUID(),
    classificationMethod: ClassificationMethod.enum.none,
    confidence: 0,
    categoryId,
    merchantKey,
    version: 0,
  });
};

describe('merchantsRepo.top', () => {
  it('orders merchants by transaction count descending', async () => {
    await insertMerchant('busy-merchant');
    await insertMerchant('quiet-merchant');
    for (let i = 0; i < 3; i += 1) await insertTx({ merchantKey: 'busy-merchant' });
    await insertTx({ merchantKey: 'quiet-merchant' });

    const rows = await repo.top(10);

    expect(rows.map((r) => [r.merchant, r.transactionCount])).toEqual([
      ['busy-merchant', 3],
      ['quiet-merchant', 1],
    ]);
  });

  it('resolves the dominant category by transaction frequency, not by any amount', async () => {
    await insertMerchant('mixed-merchant');
    const foodId = await insertCategory('Food');
    const transportId = await insertCategory('Transport');
    await insertTx({ merchantKey: 'mixed-merchant', categoryId: foodId });
    await insertTx({ merchantKey: 'mixed-merchant', categoryId: foodId });
    await insertTx({ merchantKey: 'mixed-merchant', categoryId: transportId });

    const rows = await repo.top(10);

    expect(rows).toEqual([
      { merchant: 'mixed-merchant', transactionCount: 3, categoryName: 'Food', categoryNames: null },
    ]);
  });

  it('resolves categoryName/categoryNames to null when the merchant has no classified category', async () => {
    await insertMerchant('uncategorized-merchant');
    await insertTx({ merchantKey: 'uncategorized-merchant', categoryId: null });

    const rows = await repo.top(10);

    expect(rows).toEqual([
      { merchant: 'uncategorized-merchant', transactionCount: 1, categoryName: null, categoryNames: null },
    ]);
  });

  it('excludes pending transactions — only effective transactions count', async () => {
    await insertMerchant('pending-merchant');
    await insertTx({ merchantKey: 'pending-merchant', status: TransactionStatus.enum.effective });
    await insertTx({ merchantKey: 'pending-merchant', status: TransactionStatus.enum.pending });

    const rows = await repo.top(10);

    expect(rows).toEqual([
      { merchant: 'pending-merchant', transactionCount: 1, categoryName: null, categoryNames: null },
    ]);
  });

  it('excludes transfer transactions even when they carry a merchant key', async () => {
    await insertMerchant('transfer-merchant');
    await insertTx({ merchantKey: 'transfer-merchant', type: TransactionType.enum.expense });
    await insertTx({ merchantKey: 'transfer-merchant', type: TransactionType.enum.transfer });

    const rows = await repo.top(10);

    expect(rows).toEqual([
      { merchant: 'transfer-merchant', transactionCount: 1, categoryName: null, categoryNames: null },
    ]);
  });

  it('respects the limit, keeping only the most-transacted merchants', async () => {
    await insertMerchant('rank-1');
    await insertMerchant('rank-2');
    await insertMerchant('rank-3');
    for (let i = 0; i < 3; i += 1) await insertTx({ merchantKey: 'rank-1' });
    for (let i = 0; i < 2; i += 1) await insertTx({ merchantKey: 'rank-2' });
    await insertTx({ merchantKey: 'rank-3' });

    const rows = await repo.top(2);

    expect(rows.map((r) => r.merchant)).toEqual(['rank-1', 'rank-2']);
  });

  it('never counts a transaction with no merchant at all', async () => {
    await insertTx({ merchantKey: null });

    const rows = await repo.top(10);

    expect(rows).toEqual([]);
  });
});
