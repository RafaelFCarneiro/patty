import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sql } from 'drizzle-orm';
import { okAsync } from 'neverthrow';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { McpTransport } from '../../../src/config.js';
import * as accountAdapters from '../../../src/adapters/accounts.js';
import * as billAdapters from '../../../src/adapters/bills.js';
import * as creditCardAdapters from '../../../src/adapters/creditCards.js';
import * as transactionAdapters from '../../../src/adapters/transactions.js';
import { payBill } from '../../../src/controllers/creditCard/bill.js';
import { deleteCreditCard } from '../../../src/controllers/creditCard/creditCard.js';
import type { Deps } from '../../../src/controllers/deps.js';
import { bootstrap } from '../../../src/diplomat/db/bootstrap.js';
import type { Db } from '../../../src/diplomat/db/driver.js';
import { openDatabase } from '../../../src/diplomat/db/driver.js';
import { accountApplier, accountsRepo } from '../../../src/diplomat/db/repos/accounts.js';
import { billApplier, billsRepo } from '../../../src/diplomat/db/repos/bills.js';
import { categoryApplier } from '../../../src/diplomat/db/repos/categories.js';
import { creditCardApplier, creditCardsRepo } from '../../../src/diplomat/db/repos/creditCards.js';
import { merchantCategoryApplier } from '../../../src/diplomat/db/repos/merchants.js';
import { tagApplier } from '../../../src/diplomat/db/repos/tags.js';
import { transactionApplier, transactionsRepo } from '../../../src/diplomat/db/repos/transactions.js';
import {
  accounts,
  bills,
  categories,
  creditCards,
  merchantCategory,
  tags,
  transactionTags,
  transactions,
} from '../../../src/diplomat/db/schema.js';
import {
  MAX_UNIT_OF_WORK_ATTEMPTS,
  versionedTableApplier,
  withUnitOfWork,
  type ApplierRegistry,
  type EntityApplier,
} from '../../../src/diplomat/db/unitOfWork.js';
import * as persistence from '../../../src/logic/persistence.js';
import { ACCOUNT_ENTITY_TAG, AccountType, type AccountEntity } from '../../../src/models/account.js';
import { BILL_ENTITY_TAG, BillStatus } from '../../../src/models/bill.js';
import { CATEGORY_ENTITY_TAG, CategoryKind } from '../../../src/models/category.js';
import { CREDIT_CARD_ENTITY_TAG, type CreditCardEntity } from '../../../src/models/creditCard.js';
import { Locale } from '../../../src/models/locale.js';
import { MERCHANT_CATEGORY_ENTITY_TAG } from '../../../src/models/merchant.js';
import { CurrencyCode } from '../../../src/models/money.js';
import { PersistOp, type Persistable, type PersistOutcome } from '../../../src/models/persistable.js';
import { TAG_ENTITY_TAG } from '../../../src/models/tag.js';
import {
  ClassificationMethod,
  TRANSACTION_ENTITY_TAG,
  TransactionSource,
  TransactionStatus,
  TransactionType,
} from '../../../src/models/transaction.js';
import type { TransactionRowEntity } from '../../../src/adapters/transactions.js';

const TEST_KEY = 'e'.repeat(64);

let tmpDir: string;
let db: Db;
let registry: ApplierRegistry;

beforeEach(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), 'fintrack-uow-'));
  db = openDatabase({
    DB_PATH: join(tmpDir, 'uow.db'),
    FINTRACK_DB_KEY: TEST_KEY,
    PORT: 0,
    MCP_TRANSPORT: McpTransport.enum.http,
  });
  await bootstrap(db);
  registry = { [ACCOUNT_ENTITY_TAG]: accountApplier };
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

// Carries `version` even though a fresh insert never sends it (Persistable's insert model is the
// plain `Account` — see models/persistable.ts): the same factory doubles as the seed for the
// update/delete cases below, which do need a real version to key their guard off.
const newAccount = (overrides: Partial<AccountEntity> = {}): AccountEntity => ({
  id: randomUUID(),
  name: `UoW Account ${randomUUID()}`,
  type: AccountType.enum.checking,
  currency: CurrencyCode.enum.BRL,
  initialBalance: 0,
  version: 0,
  ...overrides,
});

const insertOne = (model: AccountEntity) => () =>
  okAsync({ persist: [persistence.insert({ entity: ACCOUNT_ENTITY_TAG, model })], response: model });

/** Inserts an account row directly (raw drizzle) — test fixture setup only, never the code under
 *  test. */
const insertAccount = async (overrides: Partial<AccountEntity> = {}): Promise<AccountEntity> => {
  const account = newAccount(overrides);
  await db.insert(accounts).values(account);
  return account;
};

/** Inserts a credit card and its internal liability account directly (raw drizzle) — test fixture
 *  setup only. */
const insertCreditCardWithAccount = async (
  paymentAccountId?: string,
): Promise<{ cardId: string; accountId: string; cardName: string }> => {
  const accountId = randomUUID();
  await db.insert(accounts).values({
    id: accountId,
    name: 'Card account',
    type: AccountType.enum.credit,
    currency: CurrencyCode.enum.BRL,
    initialBalance: 0,
    version: 0,
  });

  const cardId = randomUUID();
  const cardName = `Card ${cardId}`;
  await db.insert(creditCards).values({
    id: cardId,
    name: cardName,
    currency: CurrencyCode.enum.BRL,
    closingDay: 28,
    dueDay: 5,
    accountId,
    paymentAccountId: paymentAccountId ?? null,
    version: 0,
  });

  return { cardId, accountId, cardName };
};

const readVersion = async (id: string): Promise<number | undefined> => {
  const [row] = await db.all<{ version: number }>(sql`SELECT version FROM accounts WHERE id = ${id}`);
  return row?.version;
};

const readIds = async (id: string): Promise<unknown[]> => db.all(sql`SELECT id FROM accounts WHERE id = ${id}`);

describe('withUnitOfWork — generic versioned unit of work (ADR-021 phase 1)', () => {
  it('applies a batch atomically: a version-conflicting update rolls back a sibling insert', async () => {
    const seed = newAccount();
    await withUnitOfWork(db, registry, insertOne(seed));

    const sibling = newAccount();
    const staleUpdate: Persistable = persistence.update({
      entity: ACCOUNT_ENTITY_TAG,
      model: { ...seed, name: 'renamed', version: seed.version + 41 }, // never matches
    });
    const insertSibling: Persistable = persistence.insert({ entity: ACCOUNT_ENTITY_TAG, model: sibling });

    const result = await withUnitOfWork(db, registry, () =>
      okAsync({ persist: [insertSibling, staleUpdate], response: null }),
    );

    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr()).toEqual({ code: 'conflict' });
    // The insert was in the same failed transaction on every attempt — never committed.
    expect(await readIds(sibling.id)).toHaveLength(0);
  });

  it('rolls back a version conflict, re-invokes the flow for a fresh read, and succeeds', async () => {
    const seed = newAccount();
    await withUnitOfWork(db, registry, insertOne(seed));

    let calls = 0;
    const flow = () => {
      calls += 1;
      // First call simulates a stale read (as if a concurrent writer had already bumped the
      // version); every subsequent call uses the real version, as a fresh read would.
      const version = calls === 1 ? seed.version + 1 : seed.version;
      const model: AccountEntity = { ...seed, name: 'Renamed', version };
      return okAsync({
        persist: [persistence.update({ entity: ACCOUNT_ENTITY_TAG, model })],
        response: calls,
      });
    };

    const result = await withUnitOfWork(db, registry, flow);

    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap()).toBe(2); // succeeded on the retry (flow's 2nd invocation)
    expect(await readVersion(seed.id)).toBe(seed.version + 1);
  });

  it('exhausts retries and surfaces the generic conflict error when the version never matches', async () => {
    const seed = newAccount();
    await withUnitOfWork(db, registry, insertOne(seed));

    let calls = 0;
    const flow = () => {
      calls += 1;
      const model: AccountEntity = { ...seed, name: 'Renamed', version: seed.version + 999 };
      return okAsync({
        persist: [persistence.update({ entity: ACCOUNT_ENTITY_TAG, model })],
        response: null,
      });
    };

    const result = await withUnitOfWork(db, registry, flow);

    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr()).toEqual({ code: 'conflict' });
    expect(calls).toBe(MAX_UNIT_OF_WORK_ATTEMPTS);
    expect(await readVersion(seed.id)).toBe(seed.version); // never bumped by a rolled-back attempt
  });

  it('applies a versioned delete the same way it applies a versioned update', async () => {
    const seed = newAccount();
    await withUnitOfWork(db, registry, insertOne(seed));

    const result = await withUnitOfWork(db, registry, () =>
      okAsync({
        persist: [persistence.remove({ entity: ACCOUNT_ENTITY_TAG, id: seed.id, version: seed.version })],
        response: null,
      }),
    );

    expect(result.isOk()).toBe(true);
    expect(await readIds(seed.id)).toHaveLength(0);
  });

  it('refuses a versioned delete against a stale version, leaving the row untouched', async () => {
    const seed = newAccount();
    await withUnitOfWork(db, registry, insertOne(seed));

    const result = await withUnitOfWork(db, registry, () =>
      okAsync({
        persist: [persistence.remove({ entity: ACCOUNT_ENTITY_TAG, id: seed.id, version: seed.version + 1 })],
        response: null,
      }),
    );

    expect(result.isErr()).toBe(true);
    expect(await readIds(seed.id)).toHaveLength(1);
  });

  it('treats a duplicate insert (same id) as an idempotent no-op, never a conflict', async () => {
    const model = newAccount();

    const result = await withUnitOfWork(db, registry, () =>
      okAsync({
        persist: [
          persistence.insert({ entity: ACCOUNT_ENTITY_TAG, model }),
          persistence.insert({ entity: ACCOUNT_ENTITY_TAG, model }),
        ],
        response: null,
      }),
    );

    expect(result.isOk()).toBe(true);
    expect(await readIds(model.id)).toHaveLength(1);
  });

  it('the applier is purely mechanical — it writes exactly the row it is handed, never adapts it', async () => {
    // ADR-021 follow-up: model→row adaptation (including baking in `INITIAL_VERSION` for a fresh
    // insert) happens once, explicitly, at the diplomat handler (`accountAdapters.outcomeToDb`,
    // called before `unitOfWork` ever sees the batch) — never inside `diplomat/db`. This suite
    // calls `withUnitOfWork` directly, bypassing that handler-level step, so whatever `version` the
    // test seeds here is exactly what lands in the row — proving `accountApplier` trusts its input
    // rather than re-deriving it.
    const seed = newAccount({ version: 99 });

    await withUnitOfWork(db, registry, insertOne(seed));

    expect(await readVersion(seed.id)).toBe(99);
  });

  it('is agnostic of the entity — dispatches by tag alone to any registered applier, account or not', async () => {
    const calls: unknown[] = [];
    const widgetApplier: EntityApplier = {
      insert: async (_tx, model) => {
        calls.push(model);
        return { applied: true };
      },
      update: async () => ({ applied: true }),
      delete: async () => ({ applied: true }),
    };
    const mixedRegistry: ApplierRegistry = { ...registry, widget: widgetApplier };

    const result = await withUnitOfWork(db, mixedRegistry, () =>
      okAsync({
        persist: [{ op: PersistOp.enum.insert, entity: 'widget', model: { id: 'w-1' } }],
        response: null,
      }),
    );

    expect(result.isOk()).toBe(true);
    expect(calls).toEqual([{ id: 'w-1' }]);
  });

  it('throws a clear error for a Persistable whose entity has no registered applier', async () => {
    const outcome = withUnitOfWork(db, {}, () =>
      okAsync({ persist: [{ op: PersistOp.enum.insert, entity: 'unregistered', model: {} }], response: null }),
    );

    await expect(outcome).rejects.toThrow('no applier registered for entity "unregistered"');
  });

  it('resolves an idempotency-aware response by calling it with the batch apply outcomes (rule 6)', async () => {
    const model = newAccount();

    const result = await withUnitOfWork(db, registry, () =>
      okAsync({
        persist: [persistence.insert({ entity: ACCOUNT_ENTITY_TAG, model })],
        response: (outcomes: PersistOutcome[]) => ({ created: outcomes[0]?.applied }),
      }),
    );

    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap()).toEqual({ created: true });
  });

  it('reports applied:false (not a conflict) for the outcome of an idempotent duplicate insert', async () => {
    const model = newAccount();
    await withUnitOfWork(db, registry, insertOne(model));

    const result = await withUnitOfWork(db, registry, () =>
      okAsync({
        persist: [persistence.insert({ entity: ACCOUNT_ENTITY_TAG, model })],
        response: (outcomes: PersistOutcome[]) => ({ created: outcomes[0]?.applied }),
      }),
    );

    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap()).toEqual({ created: false });
  });
});

describe('versionedTableApplier — reusable for any id/version-shaped table, not just accounts', () => {
  it('applies insert then a versioned update against a completely unrelated table (tags)', async () => {
    const tagApplier = versionedTableApplier(tags);
    const tagRegistry: ApplierRegistry = { tag: tagApplier };
    const tagId = randomUUID();

    const inserted = await withUnitOfWork(db, tagRegistry, () =>
      okAsync({
        persist: [{ op: PersistOp.enum.insert, entity: 'tag', model: { id: tagId, name: `Tag ${tagId}`, version: 0 } }],
        response: null,
      }),
    );
    expect(inserted.isOk()).toBe(true);

    const updated = await withUnitOfWork(db, tagRegistry, () =>
      okAsync({
        persist: [{ op: PersistOp.enum.update, entity: 'tag', model: { id: tagId, name: 'Renamed', version: 0 } }],
        response: null,
      }),
    );
    expect(updated.isOk()).toBe(true);

    const [row] = await db.all<{ name: string; version: number }>(
      sql`SELECT name, version FROM tags WHERE id = ${tagId}`,
    );
    expect(row).toEqual({ name: 'Renamed', version: 1 });
  });

  it('does not swallow a violation of a different unique column (tags.name) as an idempotent id-retry', async () => {
    // onConflictDoNothing is scoped to the `id` target so only a same-id retry is a no-op; a
    // genuine uniqueness violation on some other column must still surface as a real error.
    const tagApplier = versionedTableApplier(tags);
    const tagRegistry: ApplierRegistry = { tag: tagApplier };
    const name = `Tag ${randomUUID()}`;

    const first = await withUnitOfWork(db, tagRegistry, () =>
      okAsync({
        persist: [{ op: PersistOp.enum.insert, entity: 'tag', model: { id: randomUUID(), name, version: 0 } }],
        response: null,
      }),
    );
    expect(first.isOk()).toBe(true);

    const outcome = withUnitOfWork(db, tagRegistry, () =>
      okAsync({
        persist: [{ op: PersistOp.enum.insert, entity: 'tag', model: { id: randomUUID(), name, version: 0 } }],
        response: null,
      }),
    );

    await expect(outcome).rejects.toThrow();
  });
});

describe('transactionApplier — custom mechanics beyond the id/version convention (ADR-021 phase 2a)', () => {
  const transactionRegistry: ApplierRegistry = { [TRANSACTION_ENTITY_TAG]: transactionApplier };

  // Row-shaped input (as `adapters/transactions.ts`'s `entityToDb` produces it) — the applier
  // trusts it as-is, same reasoning as `newAccount` above.
  const newTransactionRow = (overrides: Partial<TransactionRowEntity> = {}): TransactionRowEntity => ({
    id: randomUUID(),
    description: 'Test transaction',
    amount: 10,
    type: TransactionType.enum.expense,
    status: TransactionStatus.enum.effective,
    date: '2026-06-01',
    currency: CurrencyCode.enum.BRL,
    source: TransactionSource.enum.mcp,
    idempotencyKey: `idem-${randomUUID()}`,
    classificationMethod: ClassificationMethod.enum.none,
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
    tagNames: [],
    ...overrides,
  });

  const insertRow = (model: TransactionRowEntity) => () =>
    okAsync({
      persist: [{ op: PersistOp.enum.insert, entity: TRANSACTION_ENTITY_TAG, model }] as Persistable[],
      response: (outcomes: PersistOutcome[]) => outcomes[0],
    });

  it('insert reports applied:true and reads back the persisted, joined view for a brand-new transaction', async () => {
    const row = newTransactionRow();

    const result = await withUnitOfWork(db, transactionRegistry, insertRow(row));

    expect(result.isOk()).toBe(true);
    const outcome = result._unsafeUnwrap();
    expect(outcome?.applied).toBe(true);
    expect((outcome?.read as { id: string }).id).toBe(row.id);
  });

  it('insert reports applied:false and reads back the EXISTING row on an idempotency-key duplicate', async () => {
    const original = newTransactionRow({ description: 'Original' });
    await withUnitOfWork(db, transactionRegistry, insertRow(original));

    // Same idempotency key, different id and description — a replay with drifted content; the
    // existing (first-write-wins) row is what must come back, not this attempt's own values.
    const replay = newTransactionRow({ idempotencyKey: original.idempotencyKey, description: 'Replay attempt' });
    const result = await withUnitOfWork(db, transactionRegistry, insertRow(replay));

    expect(result.isOk()).toBe(true);
    const outcome = result._unsafeUnwrap();
    expect(outcome?.applied).toBe(false);
    const read = outcome?.read as { id: string; description: string };
    expect(read.id).toBe(original.id);
    expect(read.description).toBe('Original');
  });

  it('insert upserts the referenced merchant row', async () => {
    const row = newTransactionRow({ merchantKey: `merchant-${randomUUID()}` });

    await withUnitOfWork(db, transactionRegistry, insertRow(row));

    const [merchantRow] = await db.all<{ key: string }>(sql`SELECT key FROM merchants WHERE key = ${row.merchantKey}`);
    expect(merchantRow?.key).toBe(row.merchantKey);
  });

  it('update upserts the referenced merchant row too, so a key introduced on update satisfies the FK', async () => {
    const row = newTransactionRow();
    await withUnitOfWork(db, transactionRegistry, insertRow(row));

    const newMerchantKey = `merchant-${randomUUID()}`;
    const updated: TransactionRowEntity = { ...row, merchantKey: newMerchantKey };
    const result = await withUnitOfWork(db, transactionRegistry, () =>
      okAsync({
        persist: [{ op: PersistOp.enum.update, entity: TRANSACTION_ENTITY_TAG, model: updated }] as Persistable[],
        response: null,
      }),
    );

    expect(result.isOk()).toBe(true);
    const [merchantRow] = await db.all<{ key: string }>(sql`SELECT key FROM merchants WHERE key = ${newMerchantKey}`);
    expect(merchantRow?.key).toBe(newMerchantKey);
    const [dbRow] = await db.all<{ merchant_key: string }>(
      sql`SELECT merchant_key FROM transactions WHERE id = ${row.id}`,
    );
    expect(dbRow?.merchant_key).toBe(newMerchantKey);
  });

  it('insert attaches only the tag names that already exist as rows, silently dropping the rest', async () => {
    const existingTagId = randomUUID();
    const existingTagName = `Tag ${existingTagId}`;
    await db.insert(tags).values({ id: existingTagId, name: existingTagName, version: 0 });

    const row = newTransactionRow({ tagNames: [existingTagName, 'does-not-exist'] });
    await withUnitOfWork(db, transactionRegistry, insertRow(row));

    const attached = await db.all<{ name: string }>(sql`
      SELECT tg.name FROM transaction_tags tt JOIN tags tg ON tg.id = tt.tag_id WHERE tt.transaction_id = ${row.id}
    `);
    expect(attached.map((r) => r.name)).toEqual([existingTagName]);
  });

  it('update is version-guarded: replaces tags and bumps version on a matching version', async () => {
    const tagId = randomUUID();
    const tagName = `Tag ${tagId}`;
    await db.insert(tags).values({ id: tagId, name: tagName, version: 0 });

    const row = newTransactionRow({ tagNames: [tagName] });
    await withUnitOfWork(db, transactionRegistry, insertRow(row));

    const updated: TransactionRowEntity = { ...row, description: 'Renamed', tagNames: [] };
    const result = await withUnitOfWork(db, transactionRegistry, () =>
      okAsync({
        persist: [{ op: PersistOp.enum.update, entity: TRANSACTION_ENTITY_TAG, model: updated }] as Persistable[],
        response: null,
      }),
    );

    expect(result.isOk()).toBe(true);
    const [dbRow] = await db.all<{ description: string; version: number }>(
      sql`SELECT description, version FROM transactions WHERE id = ${row.id}`,
    );
    expect(dbRow).toEqual({ description: 'Renamed', version: row.version + 1 });

    const remainingTags = await db.all(sql`SELECT * FROM transaction_tags WHERE transaction_id = ${row.id}`);
    expect(remainingTags).toHaveLength(0);
  });

  it('update rolls back and surfaces the generic conflict error on a stale version', async () => {
    const row = newTransactionRow();
    await withUnitOfWork(db, transactionRegistry, insertRow(row));

    const stale: TransactionRowEntity = { ...row, description: 'Stale writer', version: row.version + 5 };
    const result = await withUnitOfWork(db, transactionRegistry, () =>
      okAsync({
        persist: [{ op: PersistOp.enum.update, entity: TRANSACTION_ENTITY_TAG, model: stale }] as Persistable[],
        response: null,
      }),
    );

    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr()).toEqual({ code: 'conflict' });
  });

  it('delete is version-guarded, same as update', async () => {
    const row = newTransactionRow();
    await withUnitOfWork(db, transactionRegistry, insertRow(row));

    const result = await withUnitOfWork(db, transactionRegistry, () =>
      okAsync({
        persist: [
          { op: PersistOp.enum.delete, entity: TRANSACTION_ENTITY_TAG, id: row.id, version: row.version },
        ] as Persistable[],
        response: null,
      }),
    );

    expect(result.isOk()).toBe(true);
    expect(await db.all(sql`SELECT id FROM transactions WHERE id = ${row.id}`)).toHaveLength(0);
  });
});

describe('merchantCategoryApplier — upsert-increment mechanics (ADR-021 phase 2a)', () => {
  const merchantRegistry: ApplierRegistry = {
    [TRANSACTION_ENTITY_TAG]: transactionApplier,
    [MERCHANT_CATEGORY_ENTITY_TAG]: merchantCategoryApplier,
  };

  const seedCategory = async (): Promise<string> => {
    const categoryId = randomUUID();
    await db.insert(categories).values({ id: categoryId, name: `Category ${categoryId}`, kind: 'both', version: 0 });
    return categoryId;
  };

  it('insert creates the edge at weight 1 on a first correction', async () => {
    const categoryId = await seedCategory();
    const merchantKey = `merchant-${randomUUID()}`;

    const result = await withUnitOfWork(db, merchantRegistry, () =>
      okAsync({
        persist: [
          { op: PersistOp.enum.insert, entity: MERCHANT_CATEGORY_ENTITY_TAG, model: { merchantKey, categoryId } },
        ] as Persistable[],
        response: null,
      }),
    );

    expect(result.isOk()).toBe(true);
    const [edge] = await db.all<{ weight: number }>(
      sql`SELECT weight FROM merchant_category WHERE merchant_key = ${merchantKey} AND category_id = ${categoryId}`,
    );
    expect(edge?.weight).toBe(1);
  });

  it('a repeat correction increments weight instead of failing on the composite-key conflict', async () => {
    const categoryId = await seedCategory();
    const merchantKey = `merchant-${randomUUID()}`;
    const insertEdge = () =>
      withUnitOfWork(db, merchantRegistry, () =>
        okAsync({
          persist: [
            { op: PersistOp.enum.insert, entity: MERCHANT_CATEGORY_ENTITY_TAG, model: { merchantKey, categoryId } },
          ] as Persistable[],
          response: null,
        }),
      );

    await insertEdge();
    const second = await insertEdge();

    expect(second.isOk()).toBe(true);
    const [edge] = await db.all<{ weight: number }>(
      sql`SELECT weight FROM merchant_category WHERE merchant_key = ${merchantKey} AND category_id = ${categoryId}`,
    );
    expect(edge?.weight).toBe(2);
  });

  it('composes atomically with its transaction update: both roll back together on a stale version', async () => {
    const categoryId = await seedCategory();
    const merchantKey = `merchant-${randomUUID()}`;
    const row: TransactionRowEntity = {
      id: randomUUID(),
      description: 'Coffee',
      amount: 5,
      type: TransactionType.enum.expense,
      status: TransactionStatus.enum.effective,
      date: '2026-06-01',
      currency: CurrencyCode.enum.BRL,
      source: TransactionSource.enum.mcp,
      idempotencyKey: `idem-${randomUUID()}`,
      classificationMethod: ClassificationMethod.enum.none,
      confidence: 0,
      rawInput: null,
      note: null,
      fromAccountId: null,
      toAccountId: null,
      creditCardId: null,
      billId: null,
      categoryId: null,
      subcategoryId: null,
      merchantKey,
      version: 0,
      tagNames: [],
    };
    await withUnitOfWork(db, merchantRegistry, () =>
      okAsync({
        persist: [{ op: PersistOp.enum.insert, entity: TRANSACTION_ENTITY_TAG, model: row }] as Persistable[],
        response: null,
      }),
    );

    const staleUpdate: TransactionRowEntity = { ...row, categoryId, version: row.version + 5 }; // never matches
    const result = await withUnitOfWork(db, merchantRegistry, () =>
      okAsync({
        persist: [
          { op: PersistOp.enum.update, entity: TRANSACTION_ENTITY_TAG, model: staleUpdate },
          { op: PersistOp.enum.insert, entity: MERCHANT_CATEGORY_ENTITY_TAG, model: { merchantKey, categoryId } },
        ] as Persistable[],
        response: null,
      }),
    );

    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr()).toEqual({ code: 'conflict' });
    // The merchant-learning insert was in the same failed transaction on every attempt — never committed.
    const edges = await db.all(
      sql`SELECT 1 FROM merchant_category WHERE merchant_key = ${merchantKey} AND category_id = ${categoryId}`,
    );
    expect(edges).toHaveLength(0);
  });

  it('update throws — every write to this entity is an insert (upsert-increment), never an update', async () => {
    const categoryId = await seedCategory();
    const merchantKey = `merchant-${randomUUID()}`;

    await expect(
      withUnitOfWork(db, merchantRegistry, () =>
        okAsync({
          persist: [
            {
              op: PersistOp.enum.update,
              entity: MERCHANT_CATEGORY_ENTITY_TAG,
              model: { merchantKey, categoryId, version: 0 },
            },
          ] as Persistable[],
          response: null,
        }),
      ),
    ).rejects.toThrow('merchantCategoryApplier: update is unsupported');
  });

  it('delete throws — merchant-category edges are never removed', async () => {
    await expect(
      withUnitOfWork(db, merchantRegistry, () =>
        okAsync({
          persist: [
            { op: PersistOp.enum.delete, entity: MERCHANT_CATEGORY_ENTITY_TAG, id: 'unused', version: 0 },
          ] as Persistable[],
          response: null,
        }),
      ),
    ).rejects.toThrow('merchantCategoryApplier: delete is unsupported');
  });
});

describe('billApplier — cycle-uniqueness race surfaces as a generic conflict, not a raw throw (ADR-021 2b)', () => {
  const billRegistry: ApplierRegistry = { [BILL_ENTITY_TAG]: billApplier };

  const seedCard = async (): Promise<{ cardId: string }> => {
    const { cardId } = await insertCreditCardWithAccount();
    return { cardId };
  };

  const newBillModel = (cardId: string, overrides: Partial<{ id: string; month: number; year: number }> = {}) => ({
    id: overrides.id ?? randomUUID(),
    creditCardId: cardId,
    month: overrides.month ?? 6,
    year: overrides.year ?? 2026,
    closeDate: '2026-06-28',
    dueDate: '2026-07-05',
    status: BillStatus.enum.open,
  });

  it('inserts a brand-new cycle normally', async () => {
    const { cardId } = await seedCard();
    const model = newBillModel(cardId);

    const result = await withUnitOfWork(db, billRegistry, () =>
      okAsync({
        persist: [{ op: PersistOp.enum.insert, entity: BILL_ENTITY_TAG, model }] as Persistable[],
        response: null,
      }),
    );

    expect(result.isOk()).toBe(true);
    const [row] = await db.all<{ id: string }>(sql`SELECT id FROM bills WHERE id = ${model.id}`);
    expect(row?.id).toBe(model.id);
  });

  it('update/delete follow the plain versioned convention (versionedTableApplier mechanics)', async () => {
    const { cardId } = await seedCard();
    const model = newBillModel(cardId);
    await withUnitOfWork(db, billRegistry, () =>
      okAsync({
        persist: [{ op: PersistOp.enum.insert, entity: BILL_ENTITY_TAG, model }] as Persistable[],
        response: null,
      }),
    );

    const updated = await withUnitOfWork(db, billRegistry, () =>
      okAsync({
        persist: [
          {
            op: PersistOp.enum.update,
            entity: BILL_ENTITY_TAG,
            model: { ...model, status: BillStatus.enum.closed, version: 0 },
          },
        ] as Persistable[],
        response: null,
      }),
    );
    expect(updated.isOk()).toBe(true);
    const [row] = await db.all<{ status: string; version: number }>(
      sql`SELECT status, version FROM bills WHERE id = ${model.id}`,
    );
    expect(row).toEqual({ status: BillStatus.enum.closed, version: 1 });

    const deleted = await withUnitOfWork(db, billRegistry, () =>
      okAsync({
        persist: [{ op: PersistOp.enum.delete, entity: BILL_ENTITY_TAG, id: model.id, version: 1 }] as Persistable[],
        response: null,
      }),
    );
    expect(deleted.isOk()).toBe(true);
    expect(await db.all(sql`SELECT id FROM bills WHERE id = ${model.id}`)).toHaveLength(0);
  });

  it('a concurrent-insert cycle race exhausts retries to the generic conflict error', async () => {
    const { cardId } = await seedCard();
    // Simulate "the other writer already committed" — a bill already exists for this cycle.
    const winner = newBillModel(cardId, { month: 9, year: 2026 });
    await db.insert(bills).values({ ...winner, version: 0 });

    let attempts = 0;
    const flow = () => {
      attempts += 1;
      // A naive flow that never re-reads — always mints its own speculative id for the same
      // cycle, reproducing the loser side of the race identically on every retry.
      const loser = newBillModel(cardId, { month: 9, year: 2026 });
      return okAsync({
        persist: [{ op: PersistOp.enum.insert, entity: BILL_ENTITY_TAG, model: loser }] as Persistable[],
        response: null,
      });
    };

    const result = await withUnitOfWork(db, billRegistry, flow);

    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr()).toEqual({ code: 'conflict' });
    expect(attempts).toBe(MAX_UNIT_OF_WORK_ATTEMPTS);
    // Only the winner's row exists — no loser row was ever left half-committed by a failed attempt.
    const rows = await db.all<{ id: string }>(
      sql`SELECT id FROM bills WHERE credit_card_id = ${cardId} AND month = 9 AND year = 2026`,
    );
    expect(rows).toEqual([{ id: winner.id }]);
  });

  it('a flow that re-reads on retry recovers: sees the winner and touches it instead of re-inserting', async () => {
    const { cardId } = await seedCard();
    const winner = newBillModel(cardId, { month: 10, year: 2026 });
    await db.insert(bills).values({ ...winner, version: 0 });

    let attempts = 0;
    const flow = () => {
      attempts += 1;
      if (attempts === 1) {
        // First attempt believes the cycle is still empty — as if its own read happened just
        // before the winner's write committed.
        const loser = newBillModel(cardId, { month: 10, year: 2026 });
        return okAsync({
          persist: [{ op: PersistOp.enum.insert, entity: BILL_ENTITY_TAG, model: loser }] as Persistable[],
          response: null,
        });
      }
      // A fresh read on retry finds the winner already there — touches it instead of inserting,
      // exactly what `resolveBillWrite` (`controllers/creditCard/transaction.ts`) does.
      return okAsync({
        persist: [
          { op: PersistOp.enum.update, entity: BILL_ENTITY_TAG, model: { ...winner, version: 0 } },
        ] as Persistable[],
        response: attempts,
      });
    };

    const result = await withUnitOfWork(db, billRegistry, flow);

    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap()).toBe(2); // succeeded on the retry (flow's 2nd invocation)
    const rows = await db.all<{ id: string }>(
      sql`SELECT id FROM bills WHERE credit_card_id = ${cardId} AND month = 10 AND year = 2026`,
    );
    expect(rows).toEqual([{ id: winner.id }]); // exactly one bill — the loser's speculative id never landed
  });

  it('a genuine failure unrelated to the race still propagates, never swallowed as a conflict', async () => {
    const outcome = withUnitOfWork(db, billRegistry, () =>
      okAsync({
        // creditCardId references a non-existent card — a real FK violation, not the cycle race.
        persist: [
          { op: PersistOp.enum.insert, entity: BILL_ENTITY_TAG, model: newBillModel(randomUUID()) },
        ] as Persistable[],
        response: null,
      }),
    );

    await expect(outcome).rejects.toThrow();
  });
});

describe('payBill — atomicity through the shell (ADR-021 phase 2c, supersedes the ADR-018 atomicity test)', () => {
  const fullRegistry: ApplierRegistry = {
    [BILL_ENTITY_TAG]: billApplier,
    [TRANSACTION_ENTITY_TAG]: transactionApplier,
  };

  const seedCardWithOpenBill = async (): Promise<{ deps: Deps; cardName: string }> => {
    const accountsR = accountsRepo(db);
    const creditCardsR = creditCardsRepo(db);
    const billsR = billsRepo(db);
    const transactionsR = transactionsRepo(db);

    const payerAccountId = randomUUID();
    await insertAccount({ id: payerAccountId, name: `Payer ${payerAccountId}`, initialBalance: 1000 });

    const { cardId, accountId: cardAccountId, cardName } = await insertCreditCardWithAccount(payerAccountId);

    const bill = await billsR.ensureOpen(
      cardId,
      { month: 6, year: 2026, closeDate: '2026-06-28', dueDate: '2026-07-05' },
      randomUUID(),
    );

    await transactionsR.create(
      {
        id: randomUUID(),
        description: 'Purchase',
        amount: 100,
        type: TransactionType.enum.expense,
        status: TransactionStatus.enum.effective,
        date: '2026-06-01',
        currency: CurrencyCode.enum.BRL,
        source: TransactionSource.enum.mcp,
        idempotencyKey: `idem-${randomUUID()}`,
        classification: { method: ClassificationMethod.enum.none, confidence: 0 },
        refs: { accountId: cardAccountId, cardId, billId: bill.id },
      },
      [],
    );

    const deps: Deps = {
      accounts: accountsR,
      bills: billsR,
      categories: {} as Deps['categories'],
      subCategories: {} as Deps['subCategories'],
      creditCards: creditCardsR,
      dashboards: {} as Deps['dashboards'],
      health: {} as Deps['health'],
      merchants: {} as Deps['merchants'],
      recurring: {} as Deps['recurring'],
      settings: {} as Deps['settings'],
      tags: {} as Deps['tags'],
      transactions: transactionsR,
      clock: () => new Date('2026-06-15'),
      newId: () => randomUUID(),
      locale: async () => Locale.enum.en,
      resetLocale: () => {},
    };

    return { deps, cardName };
  };

  // Mirrors the diplomat handler's own composition (diplomat/mcp/server.ts's pay_bill tool) — a
  // test calling withUnitOfWork directly must adapt payBill's mixed transaction+bill batch itself,
  // the same way the real handler does before the batch ever reaches the shell.
  const payBillFlow = (deps: Deps, cardName: string) => () =>
    payBill(deps, { card: cardName, month: 6, year: 2026, source: TransactionSource.enum.mcp })
      .map(billAdapters.outcomeToDb)
      .map(transactionAdapters.outcomeToDb);

  const countPaymentTransfers = async (): Promise<number> => {
    const rows = await db.all<{ id: string }>(sql`SELECT id FROM transactions WHERE idempotency_key LIKE 'billpay-%'`);
    return rows.length;
  };

  it('two sequential pay_bill calls: exactly one transfer, one paid flip, second is idempotent', async () => {
    const { deps, cardName } = await seedCardWithOpenBill();

    const first = await withUnitOfWork(db, fullRegistry, payBillFlow(deps, cardName));
    expect(first.isOk()).toBe(true);
    expect(first._unsafeUnwrap().status).toBe(BillStatus.enum.paid);

    const second = await withUnitOfWork(db, fullRegistry, payBillFlow(deps, cardName));
    expect(second.isOk()).toBe(true);
    expect(second._unsafeUnwrap().status).toBe(BillStatus.enum.paid);
    expect(second._unsafeUnwrap().paymentTransactionId).toBe(first._unsafeUnwrap().paymentTransactionId);

    expect(await countPaymentTransfers()).toBe(1);
  });

  it('a concurrent bill mutation conflicts, rolls back the whole batch, and a retry lands cleanly', async () => {
    const { deps, cardName } = await seedCardWithOpenBill();

    let reads = 0;
    // Wraps the real findById read: on the FIRST call (payBill's own read-before-write), simulates
    // a concurrent bill mutation (e.g. another add_card_purchase's bill touch) landing between
    // payBill's read and the shell's apply — bumping the bill's version out-of-band right after
    // payBill has already captured the now-stale version it read, so its own version-guarded update
    // fails, rolling the whole batch (including the transfer insert) back for a retry.
    const racingBills: Deps['bills'] = {
      ...deps.bills,
      findById: async (billId) => {
        reads += 1;
        const rawBill = await deps.bills.findById(billId);
        if (reads === 1 && rawBill) {
          await db
            .update(bills)
            .set({ version: rawBill.version + 1 })
            .where(sql`${bills.id} = ${billId}`);
        }
        return rawBill;
      },
    };
    const racingDeps: Deps = { ...deps, bills: racingBills };

    const result = await withUnitOfWork(db, fullRegistry, payBillFlow(racingDeps, cardName));

    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap().status).toBe(BillStatus.enum.paid);
    expect(reads).toBe(2); // the first attempt's stale-version write conflicted; the retry's read succeeded

    // No partial write survived the rolled-back first attempt — exactly one payment transfer exists.
    expect(await countPaymentTransfers()).toBe(1);
  });
});

describe('tagApplier — name-uniqueness race surfaces as a generic conflict (ADR-021 phase 3a)', () => {
  const tagRegistry: ApplierRegistry = { [TAG_ENTITY_TAG]: tagApplier };

  it('inserts a brand-new tag normally', async () => {
    const id = randomUUID();
    const result = await withUnitOfWork(db, tagRegistry, () =>
      okAsync({
        persist: [
          { op: PersistOp.enum.insert, entity: TAG_ENTITY_TAG, model: { id, name: `Tag ${id}`, version: 0 } },
        ] as Persistable[],
        response: null,
      }),
    );
    expect(result.isOk()).toBe(true);
    expect(await db.all(sql`SELECT id FROM tags WHERE id = ${id}`)).toHaveLength(1);
  });

  it('a concurrent create-same-name race exhausts retries to the generic conflict error, never a raw 500', async () => {
    const name = `Tag ${randomUUID()}`;
    await db.insert(tags).values({ id: randomUUID(), name, version: 0 });

    let attempts = 0;
    const flow = () => {
      attempts += 1;
      // A naive flow that never re-reads — always mints its own speculative id for the same name.
      const loser = { id: randomUUID(), name, version: 0 };
      return okAsync({
        persist: [{ op: PersistOp.enum.insert, entity: TAG_ENTITY_TAG, model: loser }] as Persistable[],
        response: null,
      });
    };

    const result = await withUnitOfWork(db, tagRegistry, flow);

    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr()).toEqual({ code: 'conflict' });
    expect(attempts).toBe(MAX_UNIT_OF_WORK_ATTEMPTS);
    expect(await db.all(sql`SELECT id FROM tags WHERE name = ${name}`)).toHaveLength(1); // no loser row landed
  });
});

describe('categoryApplier — plain mechanics; merchant_category cascades via schema FK (ADR-021 3a follow-up)', () => {
  const categoryRegistry: ApplierRegistry = { [CATEGORY_ENTITY_TAG]: categoryApplier };

  const seedCategoryWithLearnedEdge = async (): Promise<string> => {
    const categoryId = randomUUID();
    await db
      .insert(categories)
      .values({ id: categoryId, name: `Category ${categoryId}`, kind: CategoryKind.enum.both, version: 0 });
    const merchantKey = `merchant-${randomUUID()}`;
    await db.run(sql`INSERT INTO merchants (key) VALUES (${merchantKey})`);
    await db
      .insert(merchantCategory)
      .values({ merchantKey, categoryId, weight: 1, origin: ClassificationMethod.enum.history });
    return categoryId;
  };

  it('deletes a category with no learned edges via the plain versioned mechanics', async () => {
    const categoryId = randomUUID();
    await db
      .insert(categories)
      .values({ id: categoryId, name: `Category ${categoryId}`, kind: CategoryKind.enum.both, version: 0 });

    const result = await withUnitOfWork(db, categoryRegistry, () =>
      okAsync({
        persist: [
          { op: PersistOp.enum.delete, entity: CATEGORY_ENTITY_TAG, id: categoryId, version: 0 },
        ] as Persistable[],
        response: null,
      }),
    );

    expect(result.isOk()).toBe(true);
    expect(await db.all(sql`SELECT id FROM categories WHERE id = ${categoryId}`)).toHaveLength(0);
  });

  it('a plain versioned delete still removes dependent merchant_category rows — the schema cascades them', async () => {
    const categoryId = await seedCategoryWithLearnedEdge();
    expect(await db.all(sql`SELECT 1 FROM merchant_category WHERE category_id = ${categoryId}`)).toHaveLength(1);

    const result = await withUnitOfWork(db, categoryRegistry, () =>
      okAsync({
        persist: [
          { op: PersistOp.enum.delete, entity: CATEGORY_ENTITY_TAG, id: categoryId, version: 0 },
        ] as Persistable[],
        response: null,
      }),
    );

    expect(result.isOk()).toBe(true);
    expect(await db.all(sql`SELECT id FROM categories WHERE id = ${categoryId}`)).toHaveLength(0);
    // Gone via merchant_category.category_id's ON DELETE CASCADE, not applier code.
    expect(await db.all(sql`SELECT 1 FROM merchant_category WHERE category_id = ${categoryId}`)).toHaveLength(0);
  });

  it('a sub-category (parentId set) is deleted the same way — same table, same applier', async () => {
    const parentId = randomUUID();
    await db
      .insert(categories)
      .values({ id: parentId, name: `Parent ${parentId}`, kind: CategoryKind.enum.both, version: 0 });
    const subId = randomUUID();
    await db
      .insert(categories)
      .values({ id: subId, name: `Sub ${subId}`, kind: CategoryKind.enum.both, parentId, version: 0 });

    const result = await withUnitOfWork(db, categoryRegistry, () =>
      okAsync({
        persist: [{ op: PersistOp.enum.delete, entity: CATEGORY_ENTITY_TAG, id: subId, version: 0 }] as Persistable[],
        response: null,
      }),
    );

    expect(result.isOk()).toBe(true);
    expect(await db.all(sql`SELECT id FROM categories WHERE id = ${subId}`)).toHaveLength(0);
  });
});

describe('creditCardApplier — plain versioned mechanics, no cascade of its own (ADR-021 phase 3a follow-up)', () => {
  const cardRegistry: ApplierRegistry = {
    [ACCOUNT_ENTITY_TAG]: accountApplier,
    [CREDIT_CARD_ENTITY_TAG]: creditCardApplier,
  };

  const insertCardWithAccount = async (): Promise<{ cardId: string; accountId: string }> => {
    const { cardId, accountId } = await insertCreditCardWithAccount();
    return { cardId, accountId };
  };

  const deleteCardBatch = (cardId: string, cardVersion: number, accountId: string, accountVersion: number) => () =>
    okAsync({
      persist: [
        { op: PersistOp.enum.delete, entity: CREDIT_CARD_ENTITY_TAG, id: cardId, version: cardVersion },
        { op: PersistOp.enum.delete, entity: ACCOUNT_ENTITY_TAG, id: accountId, version: accountVersion },
      ] as Persistable[],
      response: null,
    });

  it('a card with no correlated rows is removed along with its internal account', async () => {
    const { cardId, accountId } = await insertCardWithAccount();

    const result = await withUnitOfWork(db, cardRegistry, deleteCardBatch(cardId, 0, accountId, 0));

    expect(result.isOk()).toBe(true);
    expect(await db.all(sql`SELECT id FROM credit_cards WHERE id = ${cardId}`)).toHaveLength(0);
    expect(await db.all(sql`SELECT id FROM accounts WHERE id = ${accountId}`)).toHaveLength(0);
  });

  it('does NOT cascade a correlated bill on its own — that decision now belongs to the domain', async () => {
    // A bill left behind now surfaces a real FK violation, not a silent cascade — see the
    // deleteCreditCard describe block below for the real, domain-decided cascade.
    const { cardId, accountId } = await insertCardWithAccount();
    await db.insert(bills).values({
      id: randomUUID(),
      creditCardId: cardId,
      month: 6,
      year: 2026,
      closeDate: '2026-06-28',
      dueDate: '2026-07-05',
      status: BillStatus.enum.open,
      version: 0,
    });

    const outcome = withUnitOfWork(db, cardRegistry, deleteCardBatch(cardId, 0, accountId, 0));

    await expect(outcome).rejects.toThrow();
    expect(await db.all(sql`SELECT id FROM credit_cards WHERE id = ${cardId}`)).toHaveLength(1);
  });

  it('a stale account version rolls back the whole batch, the card cascade included — nothing partial', async () => {
    const { cardId, accountId } = await insertCardWithAccount();

    const result = await withUnitOfWork(db, cardRegistry, deleteCardBatch(cardId, 0, accountId, 99));

    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr()).toEqual({ code: 'conflict' });
    // Rolled back — the card (and its cascade) never actually committed either.
    expect(await db.all(sql`SELECT id FROM credit_cards WHERE id = ${cardId}`)).toHaveLength(1);
    expect(await db.all(sql`SELECT id FROM accounts WHERE id = ${accountId}`)).toHaveLength(1);
  });

  it('a missing card row (already deleted) reports the same conflict/retry signal as a stale version', async () => {
    const { cardId, accountId } = await insertCardWithAccount();
    await db.delete(creditCards).where(sql`${creditCards.id} = ${cardId}`);

    const result = await withUnitOfWork(db, cardRegistry, deleteCardBatch(cardId, 0, accountId, 0));

    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr()).toEqual({ code: 'conflict' });
  });

  it('two-entity insert batch [account, creditCard] applies atomically', async () => {
    const accountId = randomUUID();
    const cardId = randomUUID();
    const accountModel: AccountEntity & { version: number } = {
      id: accountId,
      name: `Card account ${accountId}`,
      type: AccountType.enum.credit,
      currency: CurrencyCode.enum.BRL,
      initialBalance: 0,
      version: 0,
    };
    const cardModel: CreditCardEntity = {
      id: cardId,
      name: `Card ${cardId}`,
      currency: CurrencyCode.enum.BRL,
      closingDay: 10,
      dueDay: 20,
      accountId,
      version: 0,
    };

    const result = await withUnitOfWork(db, cardRegistry, () =>
      okAsync({
        persist: [
          persistence.insert({ entity: ACCOUNT_ENTITY_TAG, model: accountModel }),
          persistence.insert({ entity: CREDIT_CARD_ENTITY_TAG, model: cardModel }),
        ],
        response: null,
      }),
    );

    expect(result.isOk()).toBe(true);
    expect(await db.all(sql`SELECT id FROM accounts WHERE id = ${accountId}`)).toHaveLength(1);
    expect(await db.all(sql`SELECT id FROM credit_cards WHERE id = ${cardId}`)).toHaveLength(1);
  });
});

describe('deleteCreditCard — domain-decided cascade, applied atomically end to end (ADR-021 3a follow-up)', () => {
  const fullRegistry: ApplierRegistry = {
    [ACCOUNT_ENTITY_TAG]: accountApplier,
    [CREDIT_CARD_ENTITY_TAG]: creditCardApplier,
    [BILL_ENTITY_TAG]: billApplier,
    [TRANSACTION_ENTITY_TAG]: transactionApplier,
  };

  const seedCardWithBillsAndTransactions = async (): Promise<{ deps: Deps; cardName: string; payerId: string }> => {
    const accountsR = accountsRepo(db);
    const creditCardsR = creditCardsRepo(db);
    const billsR = billsRepo(db);
    const transactionsR = transactionsRepo(db);

    const payerId = randomUUID();
    await insertAccount({ id: payerId, name: `Payer ${payerId}`, initialBalance: 1000 });

    const { cardId, accountId: cardAccountId, cardName } = await insertCreditCardWithAccount();

    // An unpaid bill with one ordinary purchase.
    const openBill = await billsR.ensureOpen(
      cardId,
      { month: 5, year: 2026, closeDate: '2026-05-28', dueDate: '2026-06-05' },
      randomUUID(),
    );
    const purchaseId = randomUUID();
    await transactionsR.create(
      {
        id: purchaseId,
        description: 'Purchase',
        amount: 40,
        type: TransactionType.enum.expense,
        status: TransactionStatus.enum.effective,
        date: '2026-05-10',
        currency: CurrencyCode.enum.BRL,
        source: TransactionSource.enum.mcp,
        idempotencyKey: `idem-${randomUUID()}`,
        classification: { method: ClassificationMethod.enum.none, confidence: 0 },
        refs: { accountId: cardAccountId, cardId, billId: openBill.id },
      },
      [],
    );
    const tagId = randomUUID();
    await db.insert(tags).values({ id: tagId, name: `Tag ${tagId}`, version: 0 });
    await db.insert(transactionTags).values({ transactionId: purchaseId, tagId });

    // A paid bill: its own purchase plus the payment transfer, wired both ways
    // (bill.payment_transaction_id <-> transfer.bill_id) exactly as payBill would leave it.
    const paidBillId = randomUUID();
    await db.insert(bills).values({
      id: paidBillId,
      creditCardId: cardId,
      month: 4,
      year: 2026,
      closeDate: '2026-04-28',
      dueDate: '2026-05-05',
      status: BillStatus.enum.paid,
      version: 0,
    });
    const paidPurchaseId = randomUUID();
    await transactionsR.create(
      {
        id: paidPurchaseId,
        description: 'Old purchase',
        amount: 60,
        type: TransactionType.enum.expense,
        status: TransactionStatus.enum.effective,
        date: '2026-04-10',
        currency: CurrencyCode.enum.BRL,
        source: TransactionSource.enum.mcp,
        idempotencyKey: `idem-${randomUUID()}`,
        classification: { method: ClassificationMethod.enum.none, confidence: 0 },
        refs: { accountId: cardAccountId, cardId, billId: paidBillId },
      },
      [],
    );
    const transferId = randomUUID();
    await transactionsR.create(
      {
        id: transferId,
        description: 'Bill payment',
        amount: 60,
        type: TransactionType.enum.transfer,
        status: TransactionStatus.enum.effective,
        date: '2026-05-01',
        currency: CurrencyCode.enum.BRL,
        source: TransactionSource.enum.mcp,
        idempotencyKey: `idem-${randomUUID()}`,
        classification: { method: ClassificationMethod.enum.none, confidence: 0 },
        refs: { accountId: payerId, toAccountId: cardAccountId, billId: paidBillId },
      },
      [],
    );
    await db
      .update(bills)
      .set({ paymentTransactionId: transferId })
      .where(sql`${bills.id} = ${paidBillId}`);

    const deps: Deps = {
      accounts: accountsR,
      bills: billsR,
      categories: {} as Deps['categories'],
      subCategories: {} as Deps['subCategories'],
      creditCards: creditCardsR,
      dashboards: {} as Deps['dashboards'],
      health: {} as Deps['health'],
      merchants: {} as Deps['merchants'],
      recurring: {} as Deps['recurring'],
      settings: {} as Deps['settings'],
      tags: {} as Deps['tags'],
      transactions: transactionsR,
      clock: () => new Date('2026-06-15'),
      newId: () => randomUUID(),
      locale: async () => Locale.enum.en,
      resetLocale: () => {},
    };

    return { deps, cardName, payerId };
  };

  const deleteCreditCardFlow = (deps: Deps, cardName: string) => () =>
    deleteCreditCard(deps, { card: cardName, confirm: true })
      .map(creditCardAdapters.outcomeToDb)
      .map(accountAdapters.outcomeToDb)
      .map(billAdapters.outcomeToDb)
      .map(transactionAdapters.outcomeToDb);

  it('removes every correlated bill/transaction, breaks the paid bill<->transfer circular FK', async () => {
    const { deps, cardName, payerId } = await seedCardWithBillsAndTransactions();

    const result = await withUnitOfWork(db, fullRegistry, deleteCreditCardFlow(deps, cardName));

    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap()).toEqual({ deleted: true, card: cardName });

    expect(await db.all(sql`SELECT id FROM credit_cards`)).toHaveLength(0);
    expect(await db.all(sql`SELECT id FROM bills`)).toHaveLength(0);
    expect(await db.all(sql`SELECT id FROM transactions WHERE credit_card_id IS NOT NULL`)).toHaveLength(0);
    expect(await db.all(sql`SELECT id FROM transactions WHERE description = ${'Bill payment'}`)).toHaveLength(0);
    expect(await db.all(sql`SELECT * FROM transaction_tags`)).toHaveLength(0);
    // The payer account (never part of the card's own cascade) survives untouched.
    expect(await db.all(sql`SELECT id FROM accounts WHERE id = ${payerId}`)).toHaveLength(1);
  });
});
