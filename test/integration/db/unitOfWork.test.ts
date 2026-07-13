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
import { tags } from '../../../src/diplomat/db/schema.js';
import {
  MAX_UNIT_OF_WORK_ATTEMPTS,
  versionedTableApplier,
  withUnitOfWork,
  type ApplierRegistry,
  type EntityApplier,
} from '../../../src/diplomat/db/unitOfWork.js';
import * as persistence from '../../../src/logic/persistence.js';
import { ACCOUNT_ENTITY_TAG, AccountType, type AccountEntity } from '../../../src/models/account.js';
import { CurrencyCode } from '../../../src/models/money.js';
import { PersistOp, type Persistable } from '../../../src/models/persistable.js';

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
      },
      update: async () => true,
      delete: async () => true,
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
