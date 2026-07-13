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
import { withUnitOfWork } from '../../../src/diplomat/db/unitOfWork.js';
import { AccountType, type AccountEntity } from '../../../src/models/account.js';
import { CurrencyCode } from '../../../src/models/money.js';
import { EntityTag, PersistOp, type Persistable } from '../../../src/models/persistable.js';

const TEST_KEY = 'e'.repeat(64);
// Matches withUnitOfWork's private MAX_UNIT_OF_WORK_ATTEMPTS (diplomat/db/unitOfWork.ts) — not
// exported, since retry count is the shell's own concern; asserted here as a black-box constant.
const MAX_ATTEMPTS = 3;

let tmpDir: string;
let db: Db;

beforeEach(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), 'fintrack-uow-'));
  db = openDatabase({
    DB_PATH: join(tmpDir, 'uow.db'),
    FINTRACK_DB_KEY: TEST_KEY,
    PORT: 0,
    MCP_TRANSPORT: McpTransport.enum.http,
  });
  await bootstrap(db);
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

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
  okAsync({ persist: [{ op: PersistOp.enum.insert, entity: EntityTag.enum.account, model }], response: model });

const readVersion = async (id: string): Promise<number | undefined> => {
  const [row] = await db.all<{ version: number }>(sql`SELECT version FROM accounts WHERE id = ${id}`);
  return row?.version;
};

const readIds = async (id: string): Promise<unknown[]> => db.all(sql`SELECT id FROM accounts WHERE id = ${id}`);

describe('withUnitOfWork — generic versioned unit of work (ADR-021 phase 1)', () => {
  it('applies a batch atomically: a version-conflicting update rolls back a sibling insert', async () => {
    const seed = newAccount();
    await withUnitOfWork(db, insertOne(seed));

    const sibling = newAccount();
    const staleUpdate: Persistable = {
      op: PersistOp.enum.update,
      entity: EntityTag.enum.account,
      model: { ...seed, name: 'renamed', version: seed.version + 41 }, // never matches
    };
    const insertSibling: Persistable = { op: PersistOp.enum.insert, entity: EntityTag.enum.account, model: sibling };

    const result = await withUnitOfWork(db, () => okAsync({ persist: [insertSibling, staleUpdate], response: null }));

    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr()).toEqual({ code: 'conflict' });
    // The insert was in the same failed transaction on every attempt — never committed.
    expect(await readIds(sibling.id)).toHaveLength(0);
  });

  it('rolls back a version conflict, re-invokes the flow for a fresh read, and succeeds', async () => {
    const seed = newAccount();
    await withUnitOfWork(db, insertOne(seed));

    let calls = 0;
    const flow = () => {
      calls += 1;
      // First call simulates a stale read (as if a concurrent writer had already bumped the
      // version); every subsequent call uses the real version, as a fresh read would.
      const version = calls === 1 ? seed.version + 1 : seed.version;
      const model: AccountEntity = { ...seed, name: 'Renamed', version };
      return okAsync({
        persist: [{ op: PersistOp.enum.update, entity: EntityTag.enum.account, model }],
        response: calls,
      });
    };

    const result = await withUnitOfWork(db, flow);

    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap()).toBe(2); // succeeded on the retry (flow's 2nd invocation)
    expect(await readVersion(seed.id)).toBe(seed.version + 1);
  });

  it('exhausts retries and surfaces the generic conflict error when the version never matches', async () => {
    const seed = newAccount();
    await withUnitOfWork(db, insertOne(seed));

    let calls = 0;
    const flow = () => {
      calls += 1;
      const model: AccountEntity = { ...seed, name: 'Renamed', version: seed.version + 999 };
      return okAsync({
        persist: [{ op: PersistOp.enum.update, entity: EntityTag.enum.account, model }],
        response: null,
      });
    };

    const result = await withUnitOfWork(db, flow);

    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr()).toEqual({ code: 'conflict' });
    expect(calls).toBe(MAX_ATTEMPTS);
    expect(await readVersion(seed.id)).toBe(seed.version); // never bumped by a rolled-back attempt
  });

  it('applies a versioned delete the same way it applies a versioned update', async () => {
    const seed = newAccount();
    await withUnitOfWork(db, insertOne(seed));

    const result = await withUnitOfWork(db, () =>
      okAsync({
        persist: [{ op: PersistOp.enum.delete, entity: EntityTag.enum.account, id: seed.id, version: seed.version }],
        response: null,
      }),
    );

    expect(result.isOk()).toBe(true);
    expect(await readIds(seed.id)).toHaveLength(0);
  });

  it('refuses a versioned delete against a stale version, leaving the row untouched', async () => {
    const seed = newAccount();
    await withUnitOfWork(db, insertOne(seed));

    const result = await withUnitOfWork(db, () =>
      okAsync({
        persist: [
          { op: PersistOp.enum.delete, entity: EntityTag.enum.account, id: seed.id, version: seed.version + 1 },
        ],
        response: null,
      }),
    );

    expect(result.isErr()).toBe(true);
    expect(await readIds(seed.id)).toHaveLength(1);
  });

  it('treats a duplicate insert (same id) as an idempotent no-op, never a conflict', async () => {
    const model = newAccount();

    const result = await withUnitOfWork(db, () =>
      okAsync({
        persist: [
          { op: PersistOp.enum.insert, entity: EntityTag.enum.account, model },
          { op: PersistOp.enum.insert, entity: EntityTag.enum.account, model },
        ],
        response: null,
      }),
    );

    expect(result.isOk()).toBe(true);
    expect(await readIds(model.id)).toHaveLength(1);
  });
});
