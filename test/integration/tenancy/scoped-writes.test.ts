import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PersistOp, type Persistable } from '@rfc0/effect-runner';
import { okAsync } from 'neverthrow';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp, type AppContext } from '../app-builder.js';
import { ACCOUNT_ENTITY_TAG } from '../../../src/models/account.js';
import { BILL_ENTITY_TAG } from '../../../src/models/bill.js';
import { BUDGET_ENTITY_TAG } from '../../../src/models/budget.js';
import { CATEGORY_ENTITY_TAG } from '../../../src/models/category.js';
import { CREDIT_CARD_ENTITY_TAG } from '../../../src/models/credit-card.js';
import { DASHBOARD_ENTITY_TAG } from '../../../src/models/dashboard.js';
import { USER_SETTINGS_ENTITY_TAG } from '../../../src/models/locale.js';
import { MERCHANT_CATEGORY_ENTITY_TAG, MERCHANT_ENTITY_TAG } from '../../../src/models/merchant.js';
import { RECURRING_ENTITY_TAG } from '../../../src/models/recurring.js';
import { TAG_ENTITY_TAG } from '../../../src/models/tag.js';
import { TRANSACTION_ENTITY_TAG } from '../../../src/models/transaction.js';
import { TRANSACTION_TAG_ENTITY_TAG } from '../../../src/models/transaction-tag.js';
import { dumpOf, seedTwoUsers, sharedDump, WORLD_A, WORLD_B } from './world.js';

/**
 * The scoped appliers on their own: even a flow handed another user's id and the right version cannot write it, nor a
 * shared default. The write matches no row, so it fails like a stale version and the engine answers `conflict`.
 */

let tmpDir: string;
let ctx: AppContext;

beforeAll(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), 'fintrack-scoped-writes-'));
  ctx = await buildApp({ dbPath: join(tmpDir, 'test.db'), auth: {} });
  await ctx.app.ready();
  await seedTwoUsers(ctx);
});

afterAll(async () => {
  await ctx.app.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

const runAs = (userId: string, persist: Persistable[]) =>
  ctx.scopedAs({ userId }).runEffects(() => okAsync({ persist, response: null }));

const update = (entity: string, model: Record<string, unknown>): Persistable =>
  ({ op: PersistOp.enum.update, entity, model: { version: 0, ...model } }) as Persistable;
const remove = (entity: string, id: string, version = 0): Persistable =>
  ({ op: PersistOp.enum.delete, entity, id, version }) as Persistable;
const insert = (entity: string, model: Record<string, unknown>, idempotencyKey?: string): Persistable =>
  ({ op: PersistOp.enum.insert, entity, model, ...(idempotencyKey ? { idempotencyKey } : {}) }) as Persistable;

const A = WORLD_A;
const B = WORLD_B;

/** Every write B's runner is handed against A's rows. The versions are right (0): only the owner is wrong. */
const WRITES_AGAINST_A: Array<[string, Persistable]> = [
  [
    'update an account',
    update(ACCOUNT_ENTITY_TAG, { id: A.acc1.id, name: 'pwned', type: 'checking', initialBalance: 1, currency: 'USD' }),
  ],
  ['delete an account', remove(ACCOUNT_ENTITY_TAG, A.acc2.id)],
  [
    'update a credit card',
    update(CREDIT_CARD_ENTITY_TAG, {
      id: A.card.id,
      name: 'pwned',
      closingDay: 1,
      dueDay: 2,
      limitAmount: null,
      currency: 'USD',
      accountId: B.acc1.id,
      paymentAccountId: null,
    }),
  ],
  ['delete a credit card', remove(CREDIT_CARD_ENTITY_TAG, A.card.id)],
  ['delete a bill', remove(BILL_ENTITY_TAG, A.bill.id)],
  [
    'update a transaction',
    update(TRANSACTION_ENTITY_TAG, {
      id: A.tx.expense,
      description: 'pwned',
      amount: 1,
      type: 'expense',
      status: 'effective',
      date: '2026-09-01',
      currency: 'USD',
      source: 'mcp',
      classificationMethod: 'user',
      confidence: 1,
      rawInput: null,
      note: null,
      fromAccountId: B.acc1.id,
      toAccountId: null,
      creditCardId: null,
      billId: null,
      categoryId: null,
      subcategoryId: null,
      merchantKey: null,
    }),
  ],
  ['delete a transaction', remove(TRANSACTION_ENTITY_TAG, A.tx.income)],
  ['update a tag', update(TAG_ENTITY_TAG, { id: A.tag.id, name: 'pwned' })],
  ['delete a tag', remove(TAG_ENTITY_TAG, A.tag.id)],
  [
    'update a budget',
    update(BUDGET_ENTITY_TAG, {
      id: A.budget.id,
      categoryId: 'cat-food',
      currency: 'USD',
      limitAmount: 1,
      period: 'monthly',
    }),
  ],
  ['delete a budget', remove(BUDGET_ENTITY_TAG, A.budget.id)],
  [
    'update a recurring rule',
    update(RECURRING_ENTITY_TAG, {
      id: A.recurring.id,
      description: 'pwned',
      amount: 1,
      type: 'expense',
      period: 'monthly',
      nextDue: '2099-01-01',
      currency: 'USD',
      accountId: null,
      categoryId: null,
      merchantKey: null,
    }),
  ],
  ['delete a recurring rule', remove(RECURRING_ENTITY_TAG, A.recurring.id)],
  [
    'update a category',
    update(CATEGORY_ENTITY_TAG, { id: A.category.id, name: 'pwned', kind: 'expense', parentId: null, names: null }),
  ],
  ['delete a category', remove(CATEGORY_ENTITY_TAG, A.category.id)],
  [
    'update a dashboard',
    update(DASHBOARD_ENTITY_TAG, {
      id: A.dashboard.id,
      name: 'pwned',
      html: '<p>pwned</p>',
      source: 'inline',
      path: null,
      updatedAt: 'now',
    }),
  ],
  ['delete a dashboard', remove(DASHBOARD_ENTITY_TAG, A.dashboard.id)],
];

/** The shared defaults: nobody's, so no scoped runner can write them. */
const WRITES_AGAINST_SHARED: Array<[string, Persistable]> = [
  [
    'rename a default category',
    update(CATEGORY_ENTITY_TAG, { id: 'cat-food', name: 'pwned', kind: 'expense', parentId: null, names: null }),
  ],
  ['delete a default category', remove(CATEGORY_ENTITY_TAG, 'cat-food')],
];

describe('a scoped runner writes only its own user’s rows', () => {
  it.each(WRITES_AGAINST_A)('cannot %s of another user (right id, right version)', async (_name, persistable) => {
    const aBefore = await dumpOf(ctx.db, A.userId);
    const sharedBefore = await sharedDump(ctx.db);

    const result = await runAs(B.userId, [persistable]);

    // A write that matches no row is a stale-version conflict: retried, then the generic conflict answer.
    expect(result.isErr(), `${_name} must not apply`).toBe(true);
    expect(result._unsafeUnwrapErr()).toEqual({ code: 'conflict' });
    expect(await dumpOf(ctx.db, A.userId)).toEqual(aBefore);
    expect(await sharedDump(ctx.db)).toEqual(sharedBefore);
  });

  it.each(WRITES_AGAINST_SHARED)('cannot %s (a shared default belongs to no one)', async (_name, persistable) => {
    const sharedBefore = await sharedDump(ctx.db);
    for (const userId of [A.userId, B.userId]) {
      const result = await runAs(userId, [persistable]);
      expect(result._unsafeUnwrapErr(), `${_name} as ${userId}`).toEqual({ code: 'conflict' });
    }
    expect(await sharedDump(ctx.db)).toEqual(sharedBefore);
  });

  it('cannot change a default dashboard or a shared merchant rule either', async () => {
    const sharedBefore = await sharedDump(ctx.db);
    const [defaultDashboard] = await ctx.db.all<{ id: string }>(
      sql`SELECT id FROM dashboards WHERE user_id IS NULL LIMIT 1`,
    );

    const renamed = await runAs(B.userId, [
      update(DASHBOARD_ENTITY_TAG, {
        id: defaultDashboard!.id,
        name: 'pwned',
        html: null,
        source: 'file',
        path: 'x.html',
        updatedAt: 'now',
      }),
    ]);
    const deleted = await runAs(B.userId, [remove(DASHBOARD_ENTITY_TAG, defaultDashboard!.id)]);

    expect(renamed._unsafeUnwrapErr()).toEqual({ code: 'conflict' });
    expect(deleted._unsafeUnwrapErr()).toEqual({ code: 'conflict' });
    expect(await sharedDump(ctx.db)).toEqual(sharedBefore);
  });

  it('has no way to address anyone’s preferences but its own: an update lands on the runner’s user alone', async () => {
    const aBefore = await dumpOf(ctx.db, A.userId);

    const result = await runAs(B.userId, [
      update(USER_SETTINGS_ENTITY_TAG, { locale: 'en', localeSource: 'explicit', baseCurrency: 'BTC' }),
    ]);

    expect(result.isOk()).toBe(true);
    const rows = await ctx.db.all<{ user_id: string; base_currency: string | null }>(
      sql`SELECT user_id, base_currency FROM user_settings ORDER BY user_id`,
    );
    expect(rows).toEqual([
      { user_id: B.userId, base_currency: 'BTC' },
      { user_id: A.userId, base_currency: null },
    ]);
    expect(await dumpOf(ctx.db, A.userId)).toEqual(aBefore);
  });

  it('never lets an insert choose its owner: a forged user id is replaced by the runner’s own', async () => {
    const aBefore = await dumpOf(ctx.db, A.userId);

    const result = await runAs(B.userId, [
      insert(ACCOUNT_ENTITY_TAG, {
        id: 'acc-forged',
        name: 'Forged',
        type: 'checking',
        initialBalance: 0,
        currency: 'USD',
        version: 0,
        userId: A.userId,
      }),
    ]);

    expect(result.isOk()).toBe(true);
    const [row] = await ctx.db.all<{ user_id: string }>(sql`SELECT user_id FROM accounts WHERE id = 'acc-forged'`);
    expect(row?.user_id).toBe(B.userId);
    expect(await dumpOf(ctx.db, A.userId)).toEqual(aBefore);
  });

  it('never lets an update move a row to another owner', async () => {
    const result = await runAs(B.userId, [
      update(ACCOUNT_ENTITY_TAG, {
        id: 'acc-forged',
        name: 'Forged',
        type: 'checking',
        initialBalance: 0,
        currency: 'USD',
        version: 0,
        userId: A.userId,
      }),
    ]);

    expect(result.isOk()).toBe(true);
    const [row] = await ctx.db.all<{ user_id: string }>(sql`SELECT user_id FROM accounts WHERE id = 'acc-forged'`);
    expect(row?.user_id).toBe(B.userId);
  });

  it('keeps a shared merchant dictionary but writes only its own learning edges', async () => {
    const aBefore = await dumpOf(ctx.db, A.userId);
    const sharedBefore = await sharedDump(ctx.db);

    // B teaches FinTrack the same (merchant, category) A taught it: a separate edge of B's own, not A's reinforced.
    const result = await runAs(B.userId, [
      insert(MERCHANT_ENTITY_TAG, { key: A.merchantKey }),
      insert(MERCHANT_CATEGORY_ENTITY_TAG, {
        merchantKey: A.merchantKey,
        categoryId: 'cat-food',
        weightDelta: 2,
        origin: 'history',
      }),
    ]);

    expect(result.isOk()).toBe(true);
    const edges = await ctx.db.all<{ user_id: string | null; weight: number }>(
      sql`SELECT user_id, weight FROM merchant_category WHERE merchant_key = ${A.merchantKey} ORDER BY weight`,
    );
    expect(edges).toEqual([
      { user_id: B.userId, weight: 2 },
      { user_id: A.userId, weight: 4 },
    ]);
    // A's own edge (to its own category) is exactly as it was.
    expect((await dumpOf(ctx.db, A.userId))['merchant_category']).toEqual(aBefore['merchant_category']);
    expect(await sharedDump(ctx.db)).toEqual(sharedBefore);
  });

  it('links tags only between the runner’s own transaction and tags', async () => {
    const aBefore = await dumpOf(ctx.db, A.userId);
    const links = (transactionId: string) =>
      ctx.db.all<{ tag_id: string }>(sql`SELECT tag_id FROM transaction_tags WHERE transaction_id = ${transactionId}`);
    const setTags = (transactionId: string, tagIds: string[]) =>
      runAs(B.userId, [insert(TRANSACTION_TAG_ENTITY_TAG, { transactionId, tagIds })]);

    // B's tag onto A's transaction; A's tag onto B's transaction; neither lands, and A's existing links are untouched.
    expect((await setTags(A.tx.expense, [B.tag.id])).isOk()).toBe(true);
    expect((await setTags(B.tx.expense, [A.tag.id])).isOk()).toBe(true);
    expect((await setTags(A.tx.expense, [])).isOk()).toBe(true); // "clear" on someone else's transaction

    expect(await links(A.tx.expense)).toEqual([{ tag_id: A.tag.id }]);
    expect(await links(B.tx.expense)).toEqual([{ tag_id: B.tag.id }]);
    expect(await dumpOf(ctx.db, A.userId)).toEqual(aBefore);
  });

  it('dedups an idempotency key per user: B may insert the very key A holds', async () => {
    const aBefore = await dumpOf(ctx.db, A.userId);
    const row = (id: string) => ({
      id,
      description: 'same statement line',
      amount: 5,
      type: 'expense',
      status: 'effective',
      date: '2026-09-09',
      currency: 'USD',
      source: 'import',
      classificationMethod: 'none',
      confidence: 0,
      rawInput: null,
      note: null,
      fromAccountId: null,
      toAccountId: null,
      creditCardId: null,
      billId: null,
      categoryId: null,
      subcategoryId: null,
      merchantKey: null,
      version: 0,
    });

    const first = await runAs(B.userId, [insert(TRANSACTION_ENTITY_TAG, row('tx-B-dup-1'), 'key-A-1')]); // A holds it
    const second = await runAs(B.userId, [insert(TRANSACTION_ENTITY_TAG, row('tx-B-dup-2'), 'key-A-1')]); // now B does

    expect(first.isOk()).toBe(true);
    expect(second.isOk()).toBe(true);
    const holders = await ctx.db.all<{ id: string; user_id: string }>(
      sql`SELECT id, user_id FROM transactions WHERE idempotency_key = 'key-A-1' ORDER BY user_id`,
    );
    expect(holders).toEqual([
      { id: 'tx-B-dup-1', user_id: B.userId },
      { id: A.tx.expense, user_id: A.userId },
    ]); // the second B insert was the duplicate; A's row never moved
    expect(await dumpOf(ctx.db, A.userId)).toEqual(aBefore);
  });
});
