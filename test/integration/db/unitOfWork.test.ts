import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sql } from 'drizzle-orm';
import { okAsync } from 'neverthrow';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { McpTransport } from '../../../src/config.js';
import { bootstrap } from '../../../src/diplomat/db/bootstrap.js';
import type { Db } from '../../../src/diplomat/db/driver.js';
import { openDatabase } from '../../../src/diplomat/db/driver.js';
import { accountApplier } from '../../../src/diplomat/db/repos/accounts.js';
import { merchantCategoryApplier } from '../../../src/diplomat/db/repos/merchants.js';
import { transactionApplier } from '../../../src/diplomat/db/repos/transactions.js';
import { categories, tags } from '../../../src/diplomat/db/schema.js';
import {
  MAX_UNIT_OF_WORK_ATTEMPTS,
  versionedTableApplier,
  withUnitOfWork,
  type ApplierRegistry,
  type EntityApplier,
} from '../../../src/diplomat/db/unitOfWork.js';
import * as persistence from '../../../src/logic/persistence.js';
import { ACCOUNT_ENTITY_TAG, AccountType, type AccountEntity } from '../../../src/models/account.js';
import { MERCHANT_CATEGORY_ENTITY_TAG } from '../../../src/models/merchant.js';
import { CurrencyCode } from '../../../src/models/money.js';
import { PersistOp, type Persistable, type PersistOutcome } from '../../../src/models/persistable.js';
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
});
