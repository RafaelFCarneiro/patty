import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LibsqlError } from '@libsql/client';
import { sql } from 'drizzle-orm';
import { errAsync, okAsync, ResultAsync } from 'neverthrow';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppError } from '../../../src/common/errors.js';
import * as accountAdapters from '../../../src/adapters/accounts.js';
import * as billAdapters from '../../../src/adapters/bills.js';
import * as creditCardAdapters from '../../../src/adapters/creditCards.js';
import * as transactionAdapters from '../../../src/adapters/transactions.js';
import { payBill } from '../../../src/controllers/creditCard/bill.js';
import { deleteCreditCard } from '../../../src/controllers/creditCard/creditCard.js';
import { renameDashboard, saveDashboard } from '../../../src/controllers/dashboards.js';
import { setLocale } from '../../../src/controllers/settings.js';
import type { Deps } from '../../../src/controllers/deps.js';
import { bootstrap } from '../../../src/diplomat/db/bootstrap.js';
import type { Db } from '../../../src/diplomat/db/driver.js';
import { openDatabase } from '../../../src/diplomat/db/driver.js';
import { accountApplier, accountsRepo } from '../../../src/diplomat/db/repos/accounts.js';
import { billApplier, billsRepo } from '../../../src/diplomat/db/repos/bills.js';
import { categoryApplier } from '../../../src/diplomat/db/repos/categories.js';
import { creditCardApplier, creditCardsRepo } from '../../../src/diplomat/db/repos/creditCards.js';
import { dashboardApplier, dashboardsRepo } from '../../../src/diplomat/db/repos/dashboards.js';
import { merchantApplier, merchantCategoryApplier } from '../../../src/diplomat/db/repos/merchants.js';
import { settingsApplier, settingsRepo } from '../../../src/diplomat/db/repos/settings.js';
import { tagApplier } from '../../../src/diplomat/db/repos/tags.js';
import { transactionApplier, transactionsRepo } from '../../../src/diplomat/db/repos/transactions.js';
import { transactionTagApplier } from '../../../src/diplomat/db/repos/transactionTags.js';
import {
  accounts,
  bills,
  categories,
  creditCards,
  dashboards,
  merchantCategory,
  settings,
  tags,
  transactionTags,
  transactions,
} from '../../../src/diplomat/db/schema.js';
import {
  MAX_RUN_EFFECTS_ATTEMPTS,
  missingIdempotencyKeyMessage,
  unexpectedIdempotencyKeyMessage,
  versionedTableApplier,
  runEffects,
  runEffectsSequence,
  type ApplierRegistry,
  type EntityApplier,
  type SequenceOutcome,
} from '../../../src/diplomat/db/effects.js';
import * as persistence from '../../../src/logic/persistence.js';
import { ACCOUNT_ENTITY_TAG, AccountType, type AccountEntity } from '../../../src/models/account.js';
import { BILL_ENTITY_TAG, BillStatus } from '../../../src/models/bill.js';
import { CATEGORY_ENTITY_TAG, CategoryKind } from '../../../src/models/category.js';
import { CREDIT_CARD_ENTITY_TAG, type CreditCardEntity } from '../../../src/models/creditCard.js';
import { DASHBOARD_ENTITY_TAG } from '../../../src/models/dashboard.js';
import { validation } from '../../../src/models/error.js';
import { Locale, LocaleSource, SETTINGS_ENTITY_TAG, SETTINGS_SINGLETON_ID } from '../../../src/models/locale.js';
import { MERCHANT_CATEGORY_ENTITY_TAG, MERCHANT_ENTITY_TAG } from '../../../src/models/merchant.js';
import { CurrencyCode } from '../../../src/models/money.js';
import { PersistOp, type FlowOutcome, type Persistable, type PersistOutcome } from '../../../src/models/persistable.js';
import { TAG_ENTITY_TAG } from '../../../src/models/tag.js';
import {
  ClassificationMethod,
  TRANSACTION_ENTITY_TAG,
  TransactionSource,
  TransactionStatus,
  TransactionType,
  type Transaction,
} from '../../../src/models/transaction.js';
import { TRANSACTION_TAG_ENTITY_TAG } from '../../../src/models/transactionTag.js';
import type { TransactionRowEntity } from '../../../src/adapters/transactions.js';

const TEST_KEY = 'e'.repeat(64);

let tmpDir: string;
let db: Db;
let registry: ApplierRegistry;

beforeEach(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), 'fintrack-uow-'));
  db = await openDatabase({
    DB_PATH: join(tmpDir, 'uow.db'),
    FINTRACK_DB_KEY: TEST_KEY,
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

/** Inserts a fresh `open` bill directly (raw drizzle) — test fixture setup only. */
const insertOpenBill = async (
  cardId: string,
  period: { month: number; year: number; closeDate: string; dueDate: string },
): Promise<{ id: string }> => {
  const id = randomUUID();
  await db.insert(bills).values({
    id,
    creditCardId: cardId,
    month: period.month,
    year: period.year,
    closeDate: period.closeDate,
    dueDate: period.dueDate,
    status: BillStatus.enum.open,
    version: 0,
  });
  return { id };
};

/** Inserts a transaction row directly (raw drizzle) — test fixture setup only. No tags in any
 *  fixture using this, so unlike the real applier this never attaches any. */
const insertTransaction = async (entity: Transaction, idempotencyKey: string): Promise<void> => {
  const { props, refs } = transactionAdapters.modelToDb(entity);
  await db.insert(transactions).values({
    id: props.id,
    description: props.description,
    amount: props.amount,
    type: props.type,
    status: props.status,
    date: props.date,
    currency: props.currency,
    source: props.source,
    idempotencyKey,
    classificationMethod: props.classificationMethod,
    confidence: props.confidence,
    rawInput: props.rawInput ?? null,
    note: props.note ?? null,
    fromAccountId: refs.accountId,
    toAccountId: refs.toAccountId,
    creditCardId: refs.cardId,
    billId: refs.billId,
    categoryId: refs.categoryId,
    subcategoryId: refs.subCategoryId,
    merchantKey: refs.merchantKey,
    version: 0,
  });
};

const readVersion = async (id: string): Promise<number | undefined> => {
  const [row] = await db.all<{ version: number }>(sql`SELECT version FROM accounts WHERE id = ${id}`);
  return row?.version;
};

const readIds = async (id: string): Promise<unknown[]> => db.all(sql`SELECT id FROM accounts WHERE id = ${id}`);

describe('runEffects — generic versioned unit of work (ADR-021 phase 1)', () => {
  it('applies a batch atomically: a version-conflicting update rolls back a sibling insert', async () => {
    const seed = newAccount();
    await runEffects(db, registry, insertOne(seed));

    const sibling = newAccount();
    const staleUpdate: Persistable = persistence.update({
      entity: ACCOUNT_ENTITY_TAG,
      model: { ...seed, name: 'renamed', version: seed.version + 41 }, // never matches
    });
    const insertSibling: Persistable = persistence.insert({ entity: ACCOUNT_ENTITY_TAG, model: sibling });

    const result = await runEffects(db, registry, () =>
      okAsync({ persist: [insertSibling, staleUpdate], response: null }),
    );

    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr()).toEqual({ code: 'conflict' });
    // The insert was in the same failed transaction on every attempt — never committed.
    expect(await readIds(sibling.id)).toHaveLength(0);
  });

  it('rolls back a version conflict, re-invokes the flow for a fresh read, and succeeds', async () => {
    const seed = newAccount();
    await runEffects(db, registry, insertOne(seed));

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

    const result = await runEffects(db, registry, flow);

    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap()).toBe(2); // succeeded on the retry (flow's 2nd invocation)
    expect(await readVersion(seed.id)).toBe(seed.version + 1);
  });

  it('exhausts retries and surfaces the generic conflict error when the version never matches', async () => {
    const seed = newAccount();
    await runEffects(db, registry, insertOne(seed));

    let calls = 0;
    const flow = () => {
      calls += 1;
      const model: AccountEntity = { ...seed, name: 'Renamed', version: seed.version + 999 };
      return okAsync({
        persist: [persistence.update({ entity: ACCOUNT_ENTITY_TAG, model })],
        response: null,
      });
    };

    const result = await runEffects(db, registry, flow);

    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr()).toEqual({ code: 'conflict' });
    expect(calls).toBe(MAX_RUN_EFFECTS_ATTEMPTS);
    expect(await readVersion(seed.id)).toBe(seed.version); // never bumped by a rolled-back attempt
  });

  it('applies a versioned delete the same way it applies a versioned update', async () => {
    const seed = newAccount();
    await runEffects(db, registry, insertOne(seed));

    const result = await runEffects(db, registry, () =>
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
    await runEffects(db, registry, insertOne(seed));

    const result = await runEffects(db, registry, () =>
      okAsync({
        persist: [persistence.remove({ entity: ACCOUNT_ENTITY_TAG, id: seed.id, version: seed.version + 1 })],
        response: null,
      }),
    );

    expect(result.isErr()).toBe(true);
    expect(await readIds(seed.id)).toHaveLength(1);
  });

  it('an empty persist batch (a dry-run preview flow) skips db.transaction entirely', async () => {
    const transactionSpy = vi.spyOn(db, 'transaction');

    const result = await runEffects(db, registry, () => okAsync({ persist: [], response: 'preview' }));

    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap()).toBe('preview');
    expect(transactionSpy).not.toHaveBeenCalled();

    transactionSpy.mockRestore();
  });

  it('treats a duplicate insert (same id) as an idempotent no-op, never a conflict', async () => {
    const model = newAccount();

    const result = await runEffects(db, registry, () =>
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
    // model→row adaptation (including baking in `INITIAL_VERSION` for a fresh insert) happens
    // once, explicitly, at the diplomat handler (`accountAdapters.outcomeToDb`, called before
    // `runEffects` ever sees the batch) — never inside `diplomat/db`. This suite calls
    // `runEffects` directly, bypassing that handler-level step, so whatever `version` the test
    // seeds here is exactly what lands in the row — proving `accountApplier` trusts its input
    // rather than re-deriving it.
    const seed = newAccount({ version: 99 });

    await runEffects(db, registry, insertOne(seed));

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

    const result = await runEffects(db, mixedRegistry, () =>
      okAsync({
        persist: [{ op: PersistOp.enum.insert, entity: 'widget', model: { id: 'w-1' } }],
        response: null,
      }),
    );

    expect(result.isOk()).toBe(true);
    expect(calls).toEqual([{ id: 'w-1' }]);
  });

  it('throws a clear error for a Persistable whose entity has no registered applier', async () => {
    const outcome = runEffects(db, {}, () =>
      okAsync({ persist: [{ op: PersistOp.enum.insert, entity: 'unregistered', model: {} }], response: null }),
    );

    await expect(outcome).rejects.toThrow('no applier registered for entity "unregistered"');
  });

  it('resolves an idempotency-aware response by calling it with the batch apply outcomes (rule 6)', async () => {
    const model = newAccount();

    const result = await runEffects(db, registry, () =>
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
    await runEffects(db, registry, insertOne(model));

    const result = await runEffects(db, registry, () =>
      okAsync({
        persist: [persistence.insert({ entity: ACCOUNT_ENTITY_TAG, model })],
        response: (outcomes: PersistOutcome[]) => ({ created: outcomes[0]?.applied }),
      }),
    );

    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap()).toEqual({ created: false });
  });
});

describe('runEffects — SQLITE_BUSY treated as a retryable physical conflict, bounded (ADR-024)', () => {
  // A raw driver error, not a real lock — proves the classification/retry path without needing a
  // second real connection to contend for the lock.
  const sqliteBusy = () => new LibsqlError('database is locked', 'SQLITE_BUSY');

  it('rolls back, re-invokes the flow, and succeeds once the lock clears — same recovery as a conflict', async () => {
    let calls = 0;
    const flakyApplier: EntityApplier = {
      ...accountApplier,
      insert: async (tx, model) => {
        calls += 1;
        if (calls === 1) throw sqliteBusy();
        return accountApplier.insert(tx, model);
      },
    };
    const flakyRegistry: ApplierRegistry = { [ACCOUNT_ENTITY_TAG]: flakyApplier };
    const model = newAccount();

    const result = await runEffects(db, flakyRegistry, insertOne(model));

    expect(result.isOk()).toBe(true);
    expect(calls).toBe(2); // failed on the first attempt, committed on the retry
    expect(await readIds(model.id)).toHaveLength(1);
  });

  it('exhausts retries and surfaces the generic conflict error when SQLITE_BUSY never clears', async () => {
    let calls = 0;
    const alwaysBusyApplier: EntityApplier = {
      ...accountApplier,
      insert: async () => {
        calls += 1;
        throw sqliteBusy();
      },
    };
    const busyRegistry: ApplierRegistry = { [ACCOUNT_ENTITY_TAG]: alwaysBusyApplier };
    const model = newAccount();

    const result = await runEffects(db, busyRegistry, insertOne(model));

    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr()).toEqual({ code: 'conflict' });
    expect(calls).toBe(MAX_RUN_EFFECTS_ATTEMPTS);
    expect(await readIds(model.id)).toHaveLength(0); // every attempt rolled back — never committed
  });
});

describe('runEffectsSequence — sequence-of-independent-units mode (ADR-022 step 2)', () => {
  type Unit = 'one' | 'two' | 'three';
  // Mirrors effects.ts's own (unexported) `Flow<T>` shape, just named here so each synthetic
  // flow below can be annotated without re-deriving `ResultAsync<FlowOutcome<T>, AppError>` inline.
  type SeqFlow<T> = () => ResultAsync<FlowOutcome<T>, AppError>;

  it('a unit that fails domain validation is recorded as err; the sibling units still commit', async () => {
    const a1 = newAccount();
    const a3 = newAccount();

    const flowFor = (unit: Unit): SeqFlow<AccountEntity> => {
      if (unit === 'two') return () => errAsync(validation(['bad line']));
      return insertOne(unit === 'one' ? a1 : a3);
    };

    const outcomes = await runEffectsSequence(db, registry, ['one', 'two', 'three'], flowFor);

    expect(outcomes[0]?.isOk()).toBe(true);
    expect(outcomes[1]?.isErr()).toBe(true);
    expect(outcomes[1]?._unsafeUnwrapErr()).toEqual({ code: 'validation', issues: ['bad line'] });
    expect(outcomes[2]?.isOk()).toBe(true);
    expect(await readIds(a1.id)).toHaveLength(1);
    expect(await readIds(a3.id)).toHaveLength(1);
  });

  it('a per-unit conflict retries only that unit — unit 1 runs once, the sequence is not restarted', async () => {
    const a1 = newAccount();
    const seed = await insertAccount();
    const a3 = newAccount();

    let unit1Calls = 0;
    let unit2Calls = 0;
    const flowFor = (unit: Unit): SeqFlow<AccountEntity | string> => {
      if (unit === 'one')
        return () => {
          unit1Calls += 1;
          return insertOne(a1)();
        };
      if (unit === 'three') return insertOne(a3);
      return () => {
        unit2Calls += 1;
        // First invocation simulates a stale read; the retry's re-invocation uses the real version.
        const version = unit2Calls === 1 ? seed.version + 1 : seed.version;
        const model: AccountEntity = { ...seed, name: 'Renamed', version };
        return okAsync({ persist: [persistence.update({ entity: ACCOUNT_ENTITY_TAG, model })], response: seed.id });
      };
    };

    const outcomes = await runEffectsSequence(db, registry, ['one', 'two', 'three'], flowFor);

    expect(outcomes.map((o) => o.isOk())).toEqual([true, true, true]);
    expect(unit1Calls).toBe(1);
    expect(unit2Calls).toBe(2); // conflicted once, succeeded on the retry
    expect(await readVersion(seed.id)).toBe(seed.version + 1);
    expect(await readIds(a1.id)).toHaveLength(1);
    expect(await readIds(a3.id)).toHaveLength(1);
  });

  it("a later unit's flow reads an earlier unit's committed write (post-commit re-invocation)", async () => {
    const a1 = newAccount();
    const a2 = newAccount();

    const flowFor = (unit: 'one' | 'two'): SeqFlow<AccountEntity | null> => {
      if (unit === 'one') return insertOne(a1);
      return () =>
        ResultAsync.fromSafePromise(readIds(a1.id)).andThen((rows) =>
          rows.length === 0
            ? errAsync(validation(['unit one not committed yet']))
            : okAsync({ persist: [persistence.insert({ entity: ACCOUNT_ENTITY_TAG, model: a2 })], response: null }),
        );
    };

    const outcomes = await runEffectsSequence(db, registry, ['one', 'two'] as const, flowFor);

    expect(outcomes[0]?.isOk()).toBe(true);
    expect(outcomes[1]?.isOk()).toBe(true);
    expect(await readIds(a1.id)).toHaveLength(1);
    expect(await readIds(a2.id)).toHaveLength(1);
  });

  it('a unit whose retries are exhausted reports conflict; the rest of the sequence still completes', async () => {
    const a1 = newAccount();
    const seed = await insertAccount();
    const a3 = newAccount();

    let seedCalls = 0;
    const flowFor = (unit: Unit): SeqFlow<AccountEntity | null> => {
      if (unit === 'one') return insertOne(a1);
      if (unit === 'three') return insertOne(a3);
      return () => {
        seedCalls += 1;
        const model: AccountEntity = { ...seed, name: 'Renamed', version: seed.version + 999 }; // never matches
        return okAsync({ persist: [persistence.update({ entity: ACCOUNT_ENTITY_TAG, model })], response: null });
      };
    };

    const outcomes = await runEffectsSequence(db, registry, ['one', 'two', 'three'], flowFor);

    expect(outcomes[0]?.isOk()).toBe(true);
    expect(outcomes[1]?.isErr()).toBe(true);
    expect(outcomes[1]?._unsafeUnwrapErr()).toEqual({ code: 'conflict' });
    expect(seedCalls).toBe(MAX_RUN_EFFECTS_ATTEMPTS);
    expect(outcomes[2]?.isOk()).toBe(true);
    expect(await readIds(a1.id)).toHaveLength(1);
    expect(await readIds(a3.id)).toHaveLength(1);
    expect(await readVersion(seed.id)).toBe(seed.version); // never bumped by an exhausted, rolled-back attempt
  });

  it('preserves order and resolves an idempotent-duplicate insert per unit', async () => {
    const shared = newAccount();
    const a3 = newAccount();

    const idempotentInsert =
      (model: AccountEntity): SeqFlow<{ created: boolean }> =>
      () =>
        okAsync({
          persist: [persistence.insert({ entity: ACCOUNT_ENTITY_TAG, model })],
          response: (outcomes: PersistOutcome[]) => ({ created: outcomes[0]?.applied ?? false }),
        });

    // Second item duplicates the first item's id — an idempotent no-op, not an error.
    const items = [shared, shared, a3];
    const outcomes: SequenceOutcome<{ created: boolean }>[] = await runEffectsSequence(
      db,
      registry,
      items,
      idempotentInsert,
    );

    expect(outcomes.map((o) => o.isOk())).toEqual([true, true, true]);
    expect(outcomes[0]?._unsafeUnwrap()).toEqual({ created: true });
    expect(outcomes[1]?._unsafeUnwrap()).toEqual({ created: false });
    expect(outcomes[2]?._unsafeUnwrap()).toEqual({ created: true });
    expect(await readIds(shared.id)).toHaveLength(1);
    expect(await readIds(a3.id)).toHaveLength(1);
  });
});

describe('versionedTableApplier — reusable for any id/version-shaped table, not just accounts', () => {
  it('applies insert then a versioned update against a completely unrelated table (tags)', async () => {
    const tagApplier = versionedTableApplier(tags);
    const tagRegistry: ApplierRegistry = { tag: tagApplier };
    const tagId = randomUUID();

    const inserted = await runEffects(db, tagRegistry, () =>
      okAsync({
        persist: [{ op: PersistOp.enum.insert, entity: 'tag', model: { id: tagId, name: `Tag ${tagId}`, version: 0 } }],
        response: null,
      }),
    );
    expect(inserted.isOk()).toBe(true);

    const updated = await runEffects(db, tagRegistry, () =>
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

    const first = await runEffects(db, tagRegistry, () =>
      okAsync({
        persist: [{ op: PersistOp.enum.insert, entity: 'tag', model: { id: randomUUID(), name, version: 0 } }],
        response: null,
      }),
    );
    expect(first.isOk()).toBe(true);

    const outcome = runEffects(db, tagRegistry, () =>
      okAsync({
        persist: [{ op: PersistOp.enum.insert, entity: 'tag', model: { id: randomUUID(), name, version: 0 } }],
        response: null,
      }),
    );

    await expect(outcome).rejects.toThrow();
  });
});

describe('engine idempotency treatment — fixed column, opt-in by envelope-key presence (ADR-029 Phase 2b)', () => {
  // The generic mechanics (fresh insert, duplicate no-op, id-guard separation, missing-key
  // rejection) are exercised against the real transactions table in the suite below; this covers
  // the remaining case — a table with no idempotencyKey column at all.
  it('an insert carrying a key for a table with no idempotencyKey column rejects loudly, never hits SQL', async () => {
    const tagRegistry: ApplierRegistry = { tag: versionedTableApplier(tags) };
    const model = { id: randomUUID(), name: `Tag ${randomUUID()}`, version: 0 };
    const flow = () =>
      okAsync({
        persist: [
          { op: PersistOp.enum.insert, entity: 'tag', model, idempotencyKey: `idem-${randomUUID()}` },
        ] as Persistable[],
        response: null,
      });

    await expect(runEffects(db, tagRegistry, flow)).rejects.toThrow(unexpectedIdempotencyKeyMessage());
    expect(await db.all(sql`SELECT id FROM tags WHERE name = ${model.name}`)).toHaveLength(0);
  });
});

// Row-shaped input (as `adapters/transactions.ts`'s `entityToDb` produces it) — the applier
// trusts it as-is, same reasoning as `newAccount` above. Module-scope: shared by every suite below.
// No `idempotencyKey` field — `insertRow` below carries it separately.
const newTransactionRow = (overrides: Partial<TransactionRowEntity> = {}): TransactionRowEntity => ({
  id: randomUUID(),
  description: 'Test transaction',
  amount: 10,
  type: TransactionType.enum.expense,
  status: TransactionStatus.enum.effective,
  date: '2026-06-01',
  currency: CurrencyCode.enum.BRL,
  source: TransactionSource.enum.mcp,
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
  ...overrides,
});

const insertRow =
  (model: TransactionRowEntity, idempotencyKey: string = `idem-${randomUUID()}`) =>
  () =>
    okAsync({
      persist: [{ op: PersistOp.enum.insert, entity: TRANSACTION_ENTITY_TAG, model, idempotencyKey }] as Persistable[],
      response: (outcomes: PersistOutcome[]) => outcomes[0],
    });

describe('transactionApplier — collapsed to a versionedTableApplier registration (ADR-023 step 3)', () => {
  const transactionRegistry: ApplierRegistry = { [TRANSACTION_ENTITY_TAG]: transactionApplier };

  it('insert reports applied:true and reads back the persisted, joined view for a brand-new transaction', async () => {
    const row = newTransactionRow();

    const result = await runEffects(db, transactionRegistry, insertRow(row));

    expect(result.isOk()).toBe(true);
    const outcome = result._unsafeUnwrap();
    expect(outcome?.applied).toBe(true);
    expect((outcome?.read as { id: string }).id).toBe(row.id);
  });

  it('insert reports applied:false and reads back the EXISTING row on an idempotency-key duplicate', async () => {
    const key = `idem-${randomUUID()}`;
    const original = newTransactionRow({ description: 'Original' });
    await runEffects(db, transactionRegistry, insertRow(original, key));

    // Same idempotency key, different id and description — a replay with drifted content; the
    // existing (first-write-wins) row is what must come back, not this attempt's own values.
    const replay = newTransactionRow({ description: 'Replay attempt' });
    const result = await runEffects(db, transactionRegistry, insertRow(replay, key));

    expect(result.isOk()).toBe(true);
    const outcome = result._unsafeUnwrap();
    expect(outcome?.applied).toBe(false);
    const read = outcome?.read as { id: string; description: string };
    expect(read.id).toBe(original.id);
    expect(read.description).toBe('Original');
  });

  it('the id guard stays separate: a same-id insert under a DIFFERENT key still raises', async () => {
    const original = newTransactionRow();
    await runEffects(db, transactionRegistry, insertRow(original, `idem-${randomUUID()}`));

    // With a key present the conflict target is the fixed idempotencyKey column, so an id
    // collision is NOT absorbed as a structural same-id retry — the two guards never merge.
    await expect(
      runEffects(db, transactionRegistry, insertRow({ ...original, description: 'Collides on id' })),
    ).rejects.toThrow();
  });

  it('an insert with no idempotencyKey on a table that has the column rejects loudly, never reaching SQL', async () => {
    const row = newTransactionRow();
    const flow = () =>
      okAsync({
        persist: [{ op: PersistOp.enum.insert, entity: TRANSACTION_ENTITY_TAG, model: row }] as Persistable[],
        response: null,
      });

    await expect(runEffects(db, transactionRegistry, flow)).rejects.toThrow(missingIdempotencyKeyMessage());
    expect(await db.all(sql`SELECT id FROM transactions WHERE id = ${row.id}`)).toHaveLength(0);
  });

  it('insert applies the given merchantKey but no longer creates the merchants row itself (ADR-023)', async () => {
    const merchantKey = `merchant-${randomUUID()}`;
    await db.run(sql`INSERT INTO merchants (key) VALUES (${merchantKey})`);
    const row = newTransactionRow({ merchantKey });

    const result = await runEffects(db, transactionRegistry, insertRow(row));

    expect(result.isOk()).toBe(true);
    const [dbRow] = await db.all<{ merchant_key: string }>(
      sql`SELECT merchant_key FROM transactions WHERE id = ${row.id}`,
    );
    expect(dbRow?.merchant_key).toBe(merchantKey);
  });

  it('insert fails on a merchantKey with no existing merchants row — the applier no longer creates one', async () => {
    const row = newTransactionRow({ merchantKey: `merchant-${randomUUID()}` });

    await expect(runEffects(db, transactionRegistry, insertRow(row))).rejects.toThrow();
  });

  it('update applies a newly-introduced merchantKey too, without creating the merchants row itself', async () => {
    const row = newTransactionRow();
    await runEffects(db, transactionRegistry, insertRow(row));

    const newMerchantKey = `merchant-${randomUUID()}`;
    await db.run(sql`INSERT INTO merchants (key) VALUES (${newMerchantKey})`);
    const updated: TransactionRowEntity = { ...row, merchantKey: newMerchantKey };
    const result = await runEffects(db, transactionRegistry, () =>
      okAsync({
        persist: [{ op: PersistOp.enum.update, entity: TRANSACTION_ENTITY_TAG, model: updated }] as Persistable[],
        response: null,
      }),
    );

    expect(result.isOk()).toBe(true);
    const [dbRow] = await db.all<{ merchant_key: string }>(
      sql`SELECT merchant_key FROM transactions WHERE id = ${row.id}`,
    );
    expect(dbRow?.merchant_key).toBe(newMerchantKey);
  });

  it('update is version-guarded: bumps version on a matching version, never touching transaction_tags', async () => {
    const row = newTransactionRow();
    await runEffects(db, transactionRegistry, insertRow(row));

    const updated: TransactionRowEntity = { ...row, description: 'Renamed' };
    const result = await runEffects(db, transactionRegistry, () =>
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
  });

  it('update rolls back and surfaces the generic conflict error on a stale version', async () => {
    const row = newTransactionRow();
    await runEffects(db, transactionRegistry, insertRow(row));

    const stale: TransactionRowEntity = { ...row, description: 'Stale writer', version: row.version + 5 };
    const result = await runEffects(db, transactionRegistry, () =>
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
    await runEffects(db, transactionRegistry, insertRow(row));

    const result = await runEffects(db, transactionRegistry, () =>
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

  it('a delete blocked by a bill-payment FK retries bounded, then surfaces the generic conflict', async () => {
    const row = newTransactionRow();
    await runEffects(db, transactionRegistry, insertRow(row));
    const { cardId } = await insertCreditCardWithAccount();
    await db.insert(bills).values({
      id: randomUUID(),
      creditCardId: cardId,
      month: 6,
      year: 2026,
      closeDate: '2026-06-28',
      dueDate: '2026-07-05',
      status: BillStatus.enum.paid,
      paymentTransactionId: row.id,
      version: 0,
    });

    let calls = 0;
    const flow = () => {
      calls += 1;
      return okAsync({
        persist: [
          { op: PersistOp.enum.delete, entity: TRANSACTION_ENTITY_TAG, id: row.id, version: row.version },
        ] as Persistable[],
        response: null,
      });
    };
    const result = await runEffects(db, transactionRegistry, flow);

    // Before the collapse the bespoke delete had no error handling and this FK violation surfaced
    // as a raw throw; the generic applier treats it as the same "world changed" condition a stale
    // version reports (bounded retry → generic conflict) — the intended behavior change.
    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr()).toEqual({ code: 'conflict' });
    expect(calls).toBe(MAX_RUN_EFFECTS_ATTEMPTS);
    expect(await db.all(sql`SELECT id FROM transactions WHERE id = ${row.id}`)).toHaveLength(1);
  });
});

describe('transactionTagApplier — set-replace addressed by the transaction id (ADR-023 steps 2–3)', () => {
  const tagLinksRegistry: ApplierRegistry = {
    [TRANSACTION_ENTITY_TAG]: transactionApplier,
    [TRANSACTION_TAG_ENTITY_TAG]: transactionTagApplier,
  };

  const seedTag = async (name: string): Promise<string> => {
    const id = randomUUID();
    await db.insert(tags).values({ id, name, version: 0 });
    return id;
  };

  const readLinkedTagNames = async (transactionId: string): Promise<string[]> => {
    const rows = await db.all<{ name: string }>(sql`
      SELECT tg.name FROM transaction_tags tt JOIN tags tg ON tg.id = tt.tag_id WHERE tt.transaction_id = ${transactionId}
    `);
    return rows.map((r) => r.name);
  };

  const insertTagSet = (transactionId: string, tagIds: string[]) => () =>
    okAsync({
      persist: [
        { op: PersistOp.enum.insert, entity: TRANSACTION_TAG_ENTITY_TAG, model: { transactionId, tagIds } },
      ] as Persistable[],
      response: (outcomes: PersistOutcome[]) => outcomes[0]?.applied,
    });

  it('attaches the given tag ids to the addressed transaction row', async () => {
    const row = newTransactionRow();
    await runEffects(db, tagLinksRegistry, insertRow(row));
    const tagId = await seedTag(`Tag ${randomUUID()}`);

    const result = await runEffects(db, tagLinksRegistry, insertTagSet(row.id, [tagId]));

    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap()).toBe(true);
    expect(await readLinkedTagNames(row.id)).toHaveLength(1);
  });

  it('is a set-replace: re-applying with a different set removes the old links, not just adds new ones', async () => {
    const row = newTransactionRow();
    await runEffects(db, tagLinksRegistry, insertRow(row));
    const firstTagId = await seedTag(`Tag ${randomUUID()}`);
    const secondTagName = `Tag ${randomUUID()}`;
    const secondTagId = await seedTag(secondTagName);

    await runEffects(db, tagLinksRegistry, insertTagSet(row.id, [firstTagId]));
    const result = await runEffects(db, tagLinksRegistry, insertTagSet(row.id, [secondTagId]));

    expect(result.isOk()).toBe(true);
    expect(await readLinkedTagNames(row.id)).toEqual([secondTagName]);
  });

  it('an empty tag id set clears every existing link', async () => {
    const row = newTransactionRow();
    await runEffects(db, tagLinksRegistry, insertRow(row));
    const tagId = await seedTag(`Tag ${randomUUID()}`);
    await runEffects(db, tagLinksRegistry, insertTagSet(row.id, [tagId]));

    const result = await runEffects(db, tagLinksRegistry, insertTagSet(row.id, []));

    expect(result.isOk()).toBe(true);
    expect(await readLinkedTagNames(row.id)).toEqual([]);
  });

  it("a set addressing a row that doesn't exist no-ops with applied:false, touching no other row's links", async () => {
    // The duplicate-replay signature: the minted id was never inserted. The FK miss is translated
    // to a no-op, never a raw error — and the batch as a whole still commits.
    const bystander = newTransactionRow();
    await runEffects(db, tagLinksRegistry, insertRow(bystander));
    const tagId = await seedTag(`Tag ${randomUUID()}`);
    await runEffects(db, tagLinksRegistry, insertTagSet(bystander.id, [tagId]));

    const result = await runEffects(db, tagLinksRegistry, insertTagSet(`never-inserted-${randomUUID()}`, [tagId]));

    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap()).toBe(false);
    expect(await readLinkedTagNames(bystander.id)).toHaveLength(1);
  });

  it('update is structurally unreachable — every write to this entity is an insert (set-replace)', async () => {
    await expect(
      runEffects(db, tagLinksRegistry, () =>
        okAsync({
          persist: [
            {
              op: PersistOp.enum.update,
              entity: TRANSACTION_TAG_ENTITY_TAG,
              model: { version: 0 },
            },
          ] as Persistable[],
          response: null,
        }),
      ),
    ).rejects.toThrow('transactionTagApplier: update is unsupported');
  });

  it('delete is structurally unreachable — links are removed via the transaction cascade', async () => {
    await expect(
      runEffects(db, tagLinksRegistry, () =>
        okAsync({
          persist: [
            { op: PersistOp.enum.delete, entity: TRANSACTION_TAG_ENTITY_TAG, id: 'unused', version: 0 },
          ] as Persistable[],
          response: null,
        }),
      ),
    ).rejects.toThrow('transactionTagApplier: delete is unsupported');
  });

  it('deleting the transaction still cascades its links, once the applier no longer manages them itself', async () => {
    const row = newTransactionRow();
    await runEffects(db, tagLinksRegistry, insertRow(row));
    const tagId = await seedTag(`Tag ${randomUUID()}`);
    await runEffects(db, tagLinksRegistry, insertTagSet(row.id, [tagId]));
    expect(await readLinkedTagNames(row.id)).toHaveLength(1);

    const result = await runEffects(db, tagLinksRegistry, () =>
      okAsync({
        persist: [
          { op: PersistOp.enum.delete, entity: TRANSACTION_ENTITY_TAG, id: row.id, version: row.version },
        ] as Persistable[],
        response: null,
      }),
    );

    expect(result.isOk()).toBe(true);
    expect(await db.all(sql`SELECT 1 FROM transaction_tags WHERE transaction_id = ${row.id}`)).toHaveLength(0);
  });
});

describe('transactionApplier + transactionTagApplier — duplicate-insert tag semantics (ADR-023 step 3)', () => {
  const combinedRegistry: ApplierRegistry = {
    [TRANSACTION_ENTITY_TAG]: transactionApplier,
    [TRANSACTION_TAG_ENTITY_TAG]: transactionTagApplier,
  };

  const seedTag = async (name: string): Promise<string> => {
    const id = randomUUID();
    await db.insert(tags).values({ id, name, version: 0 });
    return id;
  };

  const readLinkedTagNames = async (transactionId: string): Promise<string[]> => {
    const rows = await db.all<{ name: string }>(sql`
      SELECT tg.name FROM transaction_tags tt JOIN tags tg ON tg.id = tt.tag_id WHERE tt.transaction_id = ${transactionId}
    `);
    return rows.map((r) => r.name);
  };

  // The real flow shape: the tag set addresses the flow's own minted `entity.id` and trails the
  // transaction insert in the batch.
  const insertWithTags = (row: TransactionRowEntity, tagIds: string[], idempotencyKey: string) => () =>
    okAsync({
      persist: [
        { op: PersistOp.enum.insert, entity: TRANSACTION_ENTITY_TAG, model: row, idempotencyKey },
        {
          op: PersistOp.enum.insert,
          entity: TRANSACTION_TAG_ENTITY_TAG,
          model: { transactionId: row.id, tagIds },
        },
      ] as Persistable[],
      response: null,
    });

  it("a duplicate idempotency-key replay leaves the surviving row's tags untouched", async () => {
    const key = `idem-${randomUUID()}`;
    const firstTagName = `Tag ${randomUUID()}`;
    const firstTagId = await seedTag(firstTagName);
    const secondTagId = await seedTag(`Tag ${randomUUID()}`);

    const original = newTransactionRow({ description: 'Original' });
    const firstResult = await runEffects(db, combinedRegistry, insertWithTags(original, [firstTagId], key));
    expect(firstResult.isOk()).toBe(true);
    expect(await readLinkedTagNames(original.id)).toEqual([firstTagName]);

    // Same idempotency key, but a fresh id — exactly what a real replay sends. The transaction
    // insert no-ops, the replay's minted id is never inserted, and the tag set addressing it
    // no-ops on the FK miss: first-write-wins, same as the rest of the row.
    const replay = newTransactionRow({ description: 'Replay attempt' });
    const replayResult = await runEffects(db, combinedRegistry, insertWithTags(replay, [secondTagId], key));

    expect(replayResult.isOk()).toBe(true);
    expect(await readLinkedTagNames(original.id)).toEqual([firstTagName]);
    expect(await readLinkedTagNames(replay.id)).toEqual([]);
  });
});

describe('merchantApplier — hand-written single-table applier for a key-only, no-version entity (ADR-023)', () => {
  const merchantOnlyRegistry: ApplierRegistry = { [MERCHANT_ENTITY_TAG]: merchantApplier };

  it('inserts a brand-new merchant normally', async () => {
    const key = `merchant-${randomUUID()}`;

    const result = await runEffects(db, merchantOnlyRegistry, () =>
      okAsync({
        persist: [{ op: PersistOp.enum.insert, entity: MERCHANT_ENTITY_TAG, model: { key } }] as Persistable[],
        response: null,
      }),
    );

    expect(result.isOk()).toBe(true);
    expect(await db.all(sql`SELECT key FROM merchants WHERE key = ${key}`)).toEqual([{ key }]);
  });

  it('is idempotent on a repeat key — no error, no duplicate row', async () => {
    const key = `merchant-${randomUUID()}`;
    const insertMerchant = () =>
      runEffects(db, merchantOnlyRegistry, () =>
        okAsync({
          persist: [{ op: PersistOp.enum.insert, entity: MERCHANT_ENTITY_TAG, model: { key } }] as Persistable[],
          response: null,
        }),
      );

    const first = await insertMerchant();
    const second = await insertMerchant();

    expect(first.isOk()).toBe(true);
    expect(second.isOk()).toBe(true);
    expect(await db.all(sql`SELECT key FROM merchants WHERE key = ${key}`)).toEqual([{ key }]);
  });

  it('reports applied:true on a fresh key and applied:false on a repeat, never faking either', async () => {
    const key = `merchant-${randomUUID()}`;
    const insertMerchant = () =>
      runEffects(db, merchantOnlyRegistry, () =>
        okAsync({
          persist: [{ op: PersistOp.enum.insert, entity: MERCHANT_ENTITY_TAG, model: { key } }] as Persistable[],
          response: (outcomes: PersistOutcome[]) => outcomes[0]?.applied,
        }),
      );

    expect((await insertMerchant())._unsafeUnwrap()).toBe(true);
    expect((await insertMerchant())._unsafeUnwrap()).toBe(false);
  });

  it('update is structurally unreachable — a merchant is only ever inserted', async () => {
    await expect(
      runEffects(db, merchantOnlyRegistry, () =>
        okAsync({
          persist: [
            {
              op: PersistOp.enum.update,
              entity: MERCHANT_ENTITY_TAG,
              model: { version: 0 },
            } satisfies Persistable,
          ] as Persistable[],
          response: null,
        }),
      ),
    ).rejects.toThrow('merchantApplier: update is unsupported');
  });

  it('delete is structurally unreachable — merchants are never removed', async () => {
    await expect(
      runEffects(db, merchantOnlyRegistry, () =>
        okAsync({
          persist: [
            { op: PersistOp.enum.delete, entity: MERCHANT_ENTITY_TAG, id: 'unused', version: 0 },
          ] as Persistable[],
          response: null,
        }),
      ),
    ).rejects.toThrow('merchantApplier: delete is unsupported');
  });
});

describe('merchantCategoryApplier — upsert-increment mechanics, single-table (ADR-021 phase 2a / ADR-023)', () => {
  const merchantRegistry: ApplierRegistry = {
    [TRANSACTION_ENTITY_TAG]: transactionApplier,
    [MERCHANT_ENTITY_TAG]: merchantApplier,
    [MERCHANT_CATEGORY_ENTITY_TAG]: merchantCategoryApplier,
  };

  const seedCategory = async (): Promise<string> => {
    const categoryId = randomUUID();
    await db.insert(categories).values({ id: categoryId, name: `Category ${categoryId}`, kind: 'both', version: 0 });
    return categoryId;
  };

  // The applier no longer creates the referenced `merchants` row itself (ADR-023) — every test
  // below that inserts a `merchant_category`/`transactions` row needing one seeds it directly,
  // mirroring `seedCategory` above (fixture setup, never the code under test).
  const seedMerchant = async (key: string): Promise<void> => {
    await db.run(sql`INSERT INTO merchants (key) VALUES (${key})`);
  };

  it('insert applies the given weightDelta as the initial weight and the given origin (first correction)', async () => {
    const categoryId = await seedCategory();
    const merchantKey = `merchant-${randomUUID()}`;
    await seedMerchant(merchantKey);

    const result = await runEffects(db, merchantRegistry, () =>
      okAsync({
        persist: [
          {
            op: PersistOp.enum.insert,
            entity: MERCHANT_CATEGORY_ENTITY_TAG,
            model: { merchantKey, categoryId, weightDelta: 1, origin: ClassificationMethod.enum.history },
          },
        ] as Persistable[],
        response: null,
      }),
    );

    expect(result.isOk()).toBe(true);
    const [edge] = await db.all<{ weight: number; origin: string }>(
      sql`SELECT weight, origin FROM merchant_category WHERE merchant_key = ${merchantKey} AND category_id = ${categoryId}`,
    );
    expect(edge).toEqual({ weight: 1, origin: ClassificationMethod.enum.history });
  });

  it('a repeat correction increments weight by its own delta, not a composite-key conflict', async () => {
    const categoryId = await seedCategory();
    const merchantKey = `merchant-${randomUUID()}`;
    await seedMerchant(merchantKey);
    const insertEdge = () =>
      runEffects(db, merchantRegistry, () =>
        okAsync({
          persist: [
            {
              op: PersistOp.enum.insert,
              entity: MERCHANT_CATEGORY_ENTITY_TAG,
              model: { merchantKey, categoryId, weightDelta: 1, origin: ClassificationMethod.enum.history },
            },
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

  it('applies the delta it is handed on both insert and conflict paths; origin is insert-only', async () => {
    const categoryId = await seedCategory();
    const merchantKey = `merchant-${randomUUID()}`;
    await seedMerchant(merchantKey);
    const insertEdge = (weightDelta: number, origin: 'rule' | 'history') =>
      runEffects(db, merchantRegistry, () =>
        okAsync({
          persist: [
            {
              op: PersistOp.enum.insert,
              entity: MERCHANT_CATEGORY_ENTITY_TAG,
              model: { merchantKey, categoryId, weightDelta, origin },
            },
          ] as Persistable[],
          response: null,
        }),
      );

    // First observed as a rule match, weight 5.
    await insertEdge(5, ClassificationMethod.enum.rule);
    let [edge] = await db.all<{ weight: number; origin: string }>(
      sql`SELECT weight, origin FROM merchant_category WHERE merchant_key = ${merchantKey} AND category_id = ${categoryId}`,
    );
    expect(edge).toEqual({ weight: 5, origin: ClassificationMethod.enum.rule });

    // A later user correction reinforces it as `history` — the delta lands, but `origin` is
    // insert-only and is NOT overwritten on the conflict path (ADR-023 decision 2).
    const result = await insertEdge(3, ClassificationMethod.enum.history);
    expect(result.isOk()).toBe(true);
    [edge] = await db.all<{ weight: number; origin: string }>(
      sql`SELECT weight, origin FROM merchant_category WHERE merchant_key = ${merchantKey} AND category_id = ${categoryId}`,
    );
    expect(edge).toEqual({ weight: 8, origin: ClassificationMethod.enum.rule });
  });

  it('composes atomically with its transaction update: both roll back together on a stale version', async () => {
    const categoryId = await seedCategory();
    const merchantKey = `merchant-${randomUUID()}`;
    await seedMerchant(merchantKey);
    const row = newTransactionRow({ description: 'Coffee', amount: 5, merchantKey });
    await runEffects(db, merchantRegistry, () =>
      okAsync({
        persist: [
          {
            op: PersistOp.enum.insert,
            entity: TRANSACTION_ENTITY_TAG,
            model: row,
            idempotencyKey: `idem-${randomUUID()}`,
          },
        ] as Persistable[],
        response: null,
      }),
    );

    const staleUpdate: TransactionRowEntity = { ...row, categoryId, version: row.version + 5 }; // never matches
    const result = await runEffects(db, merchantRegistry, () =>
      okAsync({
        persist: [
          { op: PersistOp.enum.update, entity: TRANSACTION_ENTITY_TAG, model: staleUpdate },
          {
            op: PersistOp.enum.insert,
            entity: MERCHANT_CATEGORY_ENTITY_TAG,
            model: { merchantKey, categoryId, weightDelta: 1, origin: ClassificationMethod.enum.history },
          },
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
    const model = { merchantKey, categoryId, version: 0 };

    await expect(
      runEffects(db, merchantRegistry, () =>
        okAsync({
          persist: [{ op: PersistOp.enum.update, entity: MERCHANT_CATEGORY_ENTITY_TAG, model }] as Persistable[],
          response: null,
        }),
      ),
    ).rejects.toThrow('merchantCategoryApplier: update is unsupported');
  });

  it('delete throws — merchant-category edges are never removed', async () => {
    await expect(
      runEffects(db, merchantRegistry, () =>
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

    const result = await runEffects(db, billRegistry, () =>
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
    await runEffects(db, billRegistry, () =>
      okAsync({
        persist: [{ op: PersistOp.enum.insert, entity: BILL_ENTITY_TAG, model }] as Persistable[],
        response: null,
      }),
    );

    const closedModel = { ...model, status: BillStatus.enum.closed, version: 0 };
    const updated = await runEffects(db, billRegistry, () =>
      okAsync({
        persist: [{ op: PersistOp.enum.update, entity: BILL_ENTITY_TAG, model: closedModel }] as Persistable[],
        response: null,
      }),
    );
    expect(updated.isOk()).toBe(true);
    const [row] = await db.all<{ status: string; version: number }>(
      sql`SELECT status, version FROM bills WHERE id = ${model.id}`,
    );
    expect(row).toEqual({ status: BillStatus.enum.closed, version: 1 });

    const deleted = await runEffects(db, billRegistry, () =>
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

    const result = await runEffects(db, billRegistry, flow);

    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr()).toEqual({ code: 'conflict' });
    expect(attempts).toBe(MAX_RUN_EFFECTS_ATTEMPTS);
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

    const result = await runEffects(db, billRegistry, flow);

    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap()).toBe(2); // succeeded on the retry (flow's 2nd invocation)
    const rows = await db.all<{ id: string }>(
      sql`SELECT id FROM bills WHERE credit_card_id = ${cardId} AND month = 10 AND year = 2026`,
    );
    expect(rows).toEqual([{ id: winner.id }]); // exactly one bill — the loser's speculative id never landed
  });

  it('a genuine failure unrelated to the race still propagates, never swallowed as a conflict', async () => {
    const outcome = runEffects(db, billRegistry, () =>
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

    const bill = await insertOpenBill(cardId, { month: 6, year: 2026, closeDate: '2026-06-28', dueDate: '2026-07-05' });

    await insertTransaction(
      {
        id: randomUUID(),
        description: 'Purchase',
        amount: 100,
        type: TransactionType.enum.expense,
        status: TransactionStatus.enum.effective,
        date: '2026-06-01',
        currency: CurrencyCode.enum.BRL,
        source: TransactionSource.enum.mcp,
        classification: { method: ClassificationMethod.enum.none, confidence: 0 },
        refs: { accountId: cardAccountId, cardId, billId: bill.id },
      },
      `idem-${randomUUID()}`,
    );

    const deps: Deps = {
      accounts: accountsR,
      bills: billsR,
      budgets: {} as Deps['budgets'],
      categories: {} as Deps['categories'],
      subCategories: {} as Deps['subCategories'],
      correlations: {} as Deps['correlations'],
      creditCards: creditCardsR,
      currencies: {} as Deps['currencies'],
      currencyRates: {} as Deps['currencyRates'],
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
      rateStaleness: { fiatHours: 24, cryptoHours: 1 },
    };

    return { deps, cardName };
  };

  // Mirrors the diplomat handler's own composition (diplomat/mcp/server.ts's pay_bill tool) — a
  // test calling runEffects directly must adapt payBill's mixed transaction+bill batch itself,
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

    const first = await runEffects(db, fullRegistry, payBillFlow(deps, cardName));
    expect(first.isOk()).toBe(true);
    expect(first._unsafeUnwrap().status).toBe(BillStatus.enum.paid);

    const second = await runEffects(db, fullRegistry, payBillFlow(deps, cardName));
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

    const result = await runEffects(db, fullRegistry, payBillFlow(racingDeps, cardName));

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
    const result = await runEffects(db, tagRegistry, () =>
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

    const result = await runEffects(db, tagRegistry, flow);

    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr()).toEqual({ code: 'conflict' });
    expect(attempts).toBe(MAX_RUN_EFFECTS_ATTEMPTS);
    expect(await db.all(sql`SELECT id FROM tags WHERE name = ${name}`)).toHaveLength(1); // no loser row landed
  });
});

describe('dashboardsRepo.findByName — full-row read for rename (Feature Design 013 phase 1)', () => {
  it('returns the full entity, including id/version/html, for an existing dashboard', async () => {
    const id = randomUUID();
    const name = `dash-${randomUUID()}`;
    await db.insert(dashboards).values({ id, name, html: '<html>full</html>', updatedAt: '2026-01-01', version: 2 });

    const entity = await dashboardsRepo(db).findByName(name);

    expect(entity).toEqual({
      id,
      name,
      html: '<html>full</html>',
      updatedAt: '2026-01-01',
      version: 2,
      source: 'inline',
      path: null,
    });
  });

  it('returns null for an unknown name', async () => {
    expect(await dashboardsRepo(db).findByName(`dash-${randomUUID()}`)).toBeNull();
  });
});

describe('dashboardApplier — name-uniqueness race surfaces as a generic conflict, never a raw 500', () => {
  const dashboardRegistry: ApplierRegistry = { [DASHBOARD_ENTITY_TAG]: dashboardApplier };

  it('inserts a brand-new dashboard normally', async () => {
    const name = `dash-${randomUUID()}`;
    const result = await runEffects(db, dashboardRegistry, () =>
      okAsync({
        persist: [
          {
            op: PersistOp.enum.insert,
            entity: DASHBOARD_ENTITY_TAG,
            model: { id: randomUUID(), name, html: '<html/>', updatedAt: '2026-01-01' },
          },
        ] as Persistable[],
        response: null,
      }),
    );
    expect(result.isOk()).toBe(true);
    expect(await db.all(sql`SELECT id FROM dashboards WHERE name = ${name}`)).toHaveLength(1);
  });

  it('a concurrent same-new-name race exhausts retries to the generic conflict error, never a raw 500', async () => {
    // Now that `id` is the primary key and `name` is a secondary UNIQUE column (like tags.name), a
    // concurrent first save of the same brand-new name mints two different ids, both insert, and
    // the second raises SQLITE_CONSTRAINT_UNIQUE — the same race tagApplier/billApplier recognize.
    const name = `dash-${randomUUID()}`;
    await db
      .insert(dashboards)
      .values({ id: randomUUID(), name, html: '<html>winner</html>', updatedAt: '2026-01-01' });

    let attempts = 0;
    const flow = () => {
      attempts += 1;
      // A naive flow that never re-reads — always mints its own speculative id for the same name.
      return okAsync({
        persist: [
          {
            op: PersistOp.enum.insert,
            entity: DASHBOARD_ENTITY_TAG,
            model: { id: randomUUID(), name, html: '<html>loser</html>', updatedAt: '2026-01-02' },
          },
        ] as Persistable[],
        response: null,
      });
    };

    const result = await runEffects(db, dashboardRegistry, flow);

    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr()).toEqual({ code: 'conflict' });
    expect(attempts).toBe(MAX_RUN_EFFECTS_ATTEMPTS);
    const rows = await db.all<{ html: string }>(sql`SELECT html FROM dashboards WHERE name = ${name}`);
    expect(rows).toHaveLength(1); // no loser row landed
    expect(rows[0]?.html).toBe('<html>winner</html>');
  });

  it("saveDashboard's own retry re-reads and takes the update path when a concurrent first save races it", async () => {
    const name = `dash-${randomUUID()}`;
    const dashboardsR = dashboardsRepo(db);
    const deps: Deps = {
      dashboards: dashboardsR,
      clock: () => new Date('2026-06-01T00:00:00.000Z'),
      newId: () => randomUUID(),
      locale: async () => Locale.enum.en,
    } as unknown as Deps;

    let reads = 0;
    // Simulates a concurrent first save of the same brand-new name landing between saveDashboard's
    // own read (finding nothing, deciding "insert") and the shell applying that decision: the first
    // read still reports "absent" (so saveDashboard decides insert), but the racer's row is already
    // in place by the time the shell's `dashboardApplier.insert` runs, so that insert hits a real
    // UNIQUE conflict on `name` and the whole batch rolls back for a retry.
    const racingDashboards: Deps['dashboards'] = {
      ...dashboardsR,
      findRefByName: async (n) => {
        reads += 1;
        const existingRef = await dashboardsR.findRefByName(n);
        if (reads === 1 && existingRef === null) {
          await db
            .insert(dashboards)
            .values({ id: randomUUID(), name: n, html: '<html>racer</html>', updatedAt: '2026-05-01' });
          return null; // this read itself still predates the race — the decision is already stale
        }
        return existingRef;
      },
    };
    const racingDeps: Deps = { ...deps, dashboards: racingDashboards };

    const result = await runEffects(db, dashboardRegistry, () =>
      saveDashboard(racingDeps, name, '<section>mine</section>'),
    );

    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap()).toEqual({
      name,
      html: '<section>mine</section>',
      updatedAt: '2026-06-01T00:00:00.000Z',
      source: 'inline',
    });
    const rows = await db.all<{ html: string; version: number }>(
      sql`SELECT html, version FROM dashboards WHERE name = ${name}`,
    );
    expect(rows).toHaveLength(1); // exactly one row — the racer's insert, then this flow's update
    expect(rows[0]?.html).toBe('<section>mine</section>');
    expect(rows[0]?.version).toBe(1); // version 0 (racer's insert) → 1 (this flow's update)
  });

  it("renameDashboard's update retries on a concurrent newName claim and surfaces duplicate_name", async () => {
    const name = `dash-${randomUUID()}`;
    const newName = `dash-${randomUUID()}`;
    await db.insert(dashboards).values({ id: randomUUID(), name, html: '<html>mine</html>', updatedAt: '2026-01-01' });
    const dashboardsR = dashboardsRepo(db);

    let racerReads = 0;
    const racingDashboards: Deps['dashboards'] = {
      ...dashboardsR,
      findRefByName: async (n) => {
        const existingRef = await dashboardsR.findRefByName(n);
        if (n !== newName) return existingRef;
        racerReads += 1;
        if (racerReads === 1 && existingRef === null) {
          await db
            .insert(dashboards)
            .values({ id: randomUUID(), name: newName, html: '<html>racer</html>', updatedAt: '2026-05-01' });
          return null; // this read itself still predates the race — the decision is already stale
        }
        return existingRef;
      },
    };
    const deps: Deps = {
      dashboards: racingDashboards,
      clock: () => new Date('2026-06-01T00:00:00.000Z'),
      locale: async () => Locale.enum.en,
    } as unknown as Deps;

    const result = await runEffects(db, dashboardRegistry, () => renameDashboard(deps, name, newName));

    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr()).toEqual({ code: 'duplicate_name', entity: 'dashboard', name: newName });
    const [original] = await db.all<{ html: string; version: number }>(
      sql`SELECT html, version FROM dashboards WHERE name = ${name}`,
    );
    expect(original).toEqual({ html: '<html>mine</html>', version: 0 }); // untouched — the retried update never landed
  });
});

describe("settingsApplier — a concurrent first insert on the singleton retries, doesn't silently no-op", () => {
  const settingsRegistry: ApplierRegistry = { [SETTINGS_ENTITY_TAG]: settingsApplier };

  it('inserts the singleton row normally when absent', async () => {
    const result = await runEffects(db, settingsRegistry, () =>
      okAsync({
        persist: [
          {
            op: PersistOp.enum.insert,
            entity: SETTINGS_ENTITY_TAG,
            model: { id: SETTINGS_SINGLETON_ID, locale: Locale.enum.en, localeSource: LocaleSource.enum.explicit },
          },
        ] as Persistable[],
        response: null,
      }),
    );
    expect(result.isOk()).toBe(true);
    const [row] = await db.all<{ locale: string }>(
      sql`SELECT locale FROM settings WHERE id = ${SETTINGS_SINGLETON_ID}`,
    );
    expect(row?.locale).toBe(Locale.enum.en);
  });

  it('a concurrent first insert on the same singleton id retries rather than reporting a false success', async () => {
    // versionedTableApplier's own insert scopes onConflictDoNothing to `id` — for a random-UUID
    // entity that never actually collides, so this never fires. `settings.id` is always the same
    // constant, so a genuine concurrent first-insert race silently no-ops here instead: without
    // settingsApplier's own applied-check, the loser's flow would report success despite its value
    // never landing. This asserts the wrapper turns that no-op into a retried conflict instead.
    await db
      .insert(settings)
      .values({ id: SETTINGS_SINGLETON_ID, locale: Locale.enum.pt, localeSource: LocaleSource.enum.explicit });

    let attempts = 0;
    const flow = () => {
      attempts += 1;
      // A naive flow that never re-reads — always attempts a fresh insert of the singleton.
      return okAsync({
        persist: [
          {
            op: PersistOp.enum.insert,
            entity: SETTINGS_ENTITY_TAG,
            model: { id: SETTINGS_SINGLETON_ID, locale: Locale.enum.es, localeSource: LocaleSource.enum.explicit },
          },
        ] as Persistable[],
        response: null,
      });
    };

    const result = await runEffects(db, settingsRegistry, flow);

    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr()).toEqual({ code: 'conflict' });
    expect(attempts).toBe(MAX_RUN_EFFECTS_ATTEMPTS);
    const [row] = await db.all<{ locale: string }>(
      sql`SELECT locale FROM settings WHERE id = ${SETTINGS_SINGLETON_ID}`,
    );
    expect(row?.locale).toBe(Locale.enum.pt); // the winner's value, never overwritten by the loser
  });

  it("setLocale's own retry re-reads and takes the update path when a concurrent first insert races it", async () => {
    const settingsR = settingsRepo(db);
    const deps = { settings: settingsR } as unknown as Deps;

    let reads = 0;
    const racingSettings: Deps['settings'] = {
      getLocale: async () => {
        reads += 1;
        const existing = await settingsR.getLocale();
        if (reads === 1 && !existing) {
          await db
            .insert(settings)
            .values({ id: SETTINGS_SINGLETON_ID, locale: Locale.enum.pt, localeSource: LocaleSource.enum.inferred });
          return undefined; // this read itself still predates the race — the decision is already stale
        }
        return existing;
      },
    };
    const racingDeps: Deps = { ...deps, settings: racingSettings };

    const result = await runEffects(db, settingsRegistry, () =>
      setLocale(racingDeps, { locale: Locale.enum.es, source: LocaleSource.enum.explicit }),
    );

    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap()).toEqual({ locale: Locale.enum.es, localeSource: LocaleSource.enum.explicit });
    const rows = await db.all<{ locale: string; version: number }>(
      sql`SELECT locale, version FROM settings WHERE id = ${SETTINGS_SINGLETON_ID}`,
    );
    expect(rows).toHaveLength(1); // exactly one row — the racer's insert, then this flow's update
    expect(rows[0]?.locale).toBe(Locale.enum.es);
    expect(rows[0]?.version).toBe(1); // version 0 (racer's insert) → 1 (this flow's update)
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

    const result = await runEffects(db, categoryRegistry, () =>
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

    const result = await runEffects(db, categoryRegistry, () =>
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

    const result = await runEffects(db, categoryRegistry, () =>
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

    const result = await runEffects(db, cardRegistry, deleteCardBatch(cardId, 0, accountId, 0));

    expect(result.isOk()).toBe(true);
    expect(await db.all(sql`SELECT id FROM credit_cards WHERE id = ${cardId}`)).toHaveLength(0);
    expect(await db.all(sql`SELECT id FROM accounts WHERE id = ${accountId}`)).toHaveLength(0);
  });

  it('does NOT cascade a correlated bill on its own — that decision now belongs to the domain', async () => {
    // A bill left behind trips the card row's own FK constraint on every retry (this batch is a
    // fixed lambda, not a re-reading flow) — surfacing as the generic conflict, not a raw FK
    // throw. See the deleteCreditCard describe block below for the real, domain-decided cascade.
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

    const result = await runEffects(db, cardRegistry, deleteCardBatch(cardId, 0, accountId, 0));

    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr()).toEqual({ code: 'conflict' });
    expect(await db.all(sql`SELECT id FROM credit_cards WHERE id = ${cardId}`)).toHaveLength(1);
  });

  it('a stale account version rolls back the whole batch, the card cascade included — nothing partial', async () => {
    const { cardId, accountId } = await insertCardWithAccount();

    const result = await runEffects(db, cardRegistry, deleteCardBatch(cardId, 0, accountId, 99));

    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr()).toEqual({ code: 'conflict' });
    // Rolled back — the card (and its cascade) never actually committed either.
    expect(await db.all(sql`SELECT id FROM credit_cards WHERE id = ${cardId}`)).toHaveLength(1);
    expect(await db.all(sql`SELECT id FROM accounts WHERE id = ${accountId}`)).toHaveLength(1);
  });

  it('a missing card row (already deleted) reports the same conflict/retry signal as a stale version', async () => {
    const { cardId, accountId } = await insertCardWithAccount();
    await db.delete(creditCards).where(sql`${creditCards.id} = ${cardId}`);

    const result = await runEffects(db, cardRegistry, deleteCardBatch(cardId, 0, accountId, 0));

    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr()).toEqual({ code: 'conflict' });
  });

  it('a row referencing the card, inserted after the read, is caught on delete and resolved by a retry', async () => {
    // A bill lands in the window between this flow's own read and its batch being applied — as
    // if another writer (e.g. a concurrent add_card_purchase) committed it concurrently. The
    // card's own delete trips the bill's FK reference; that's caught and retried (rule 4) rather
    // than surfacing as a raw throw, and the retried flow picks the new bill up.
    const { cardId, accountId } = await insertCardWithAccount();
    const raceRegistry: ApplierRegistry = { ...cardRegistry, [BILL_ENTITY_TAG]: billApplier };
    const billId = randomUUID();

    let attempts = 0;
    const flow = () => {
      attempts += 1;
      if (attempts === 1) {
        return ResultAsync.fromSafePromise(
          db.insert(bills).values({
            id: billId,
            creditCardId: cardId,
            month: 6,
            year: 2026,
            closeDate: '2026-06-28',
            dueDate: '2026-07-05',
            status: BillStatus.enum.open,
            version: 0,
          }),
        ).map(() => ({
          persist: [
            { op: PersistOp.enum.delete, entity: CREDIT_CARD_ENTITY_TAG, id: cardId, version: 0 },
            { op: PersistOp.enum.delete, entity: ACCOUNT_ENTITY_TAG, id: accountId, version: 0 },
          ] as Persistable[],
          response: attempts,
        }));
      }
      return okAsync({
        persist: [
          { op: PersistOp.enum.delete, entity: BILL_ENTITY_TAG, id: billId, version: 0 },
          { op: PersistOp.enum.delete, entity: CREDIT_CARD_ENTITY_TAG, id: cardId, version: 0 },
          { op: PersistOp.enum.delete, entity: ACCOUNT_ENTITY_TAG, id: accountId, version: 0 },
        ] as Persistable[],
        response: attempts,
      });
    };

    const result = await runEffects(db, raceRegistry, flow);

    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap()).toBe(2);
    expect(await db.all(sql`SELECT id FROM credit_cards WHERE id = ${cardId}`)).toHaveLength(0);
    expect(await db.all(sql`SELECT id FROM accounts WHERE id = ${accountId}`)).toHaveLength(0);
    expect(await db.all(sql`SELECT id FROM bills WHERE id = ${billId}`)).toHaveLength(0);
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

    const result = await runEffects(db, cardRegistry, () =>
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
    const openBill = await insertOpenBill(cardId, {
      month: 5,
      year: 2026,
      closeDate: '2026-05-28',
      dueDate: '2026-06-05',
    });
    const purchaseId = randomUUID();
    await insertTransaction(
      {
        id: purchaseId,
        description: 'Purchase',
        amount: 40,
        type: TransactionType.enum.expense,
        status: TransactionStatus.enum.effective,
        date: '2026-05-10',
        currency: CurrencyCode.enum.BRL,
        source: TransactionSource.enum.mcp,
        classification: { method: ClassificationMethod.enum.none, confidence: 0 },
        refs: { accountId: cardAccountId, cardId, billId: openBill.id },
      },
      `idem-${randomUUID()}`,
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
    await insertTransaction(
      {
        id: paidPurchaseId,
        description: 'Old purchase',
        amount: 60,
        type: TransactionType.enum.expense,
        status: TransactionStatus.enum.effective,
        date: '2026-04-10',
        currency: CurrencyCode.enum.BRL,
        source: TransactionSource.enum.mcp,
        classification: { method: ClassificationMethod.enum.none, confidence: 0 },
        refs: { accountId: cardAccountId, cardId, billId: paidBillId },
      },
      `idem-${randomUUID()}`,
    );
    const transferId = randomUUID();
    await insertTransaction(
      {
        id: transferId,
        description: 'Bill payment',
        amount: 60,
        type: TransactionType.enum.transfer,
        status: TransactionStatus.enum.effective,
        date: '2026-05-01',
        currency: CurrencyCode.enum.BRL,
        source: TransactionSource.enum.mcp,
        classification: { method: ClassificationMethod.enum.none, confidence: 0 },
        refs: { accountId: payerId, toAccountId: cardAccountId, billId: paidBillId },
      },
      `idem-${randomUUID()}`,
    );
    await db
      .update(bills)
      .set({ paymentTransactionId: transferId })
      .where(sql`${bills.id} = ${paidBillId}`);

    const deps: Deps = {
      accounts: accountsR,
      bills: billsR,
      budgets: {} as Deps['budgets'],
      categories: {} as Deps['categories'],
      subCategories: {} as Deps['subCategories'],
      correlations: {} as Deps['correlations'],
      creditCards: creditCardsR,
      currencies: {} as Deps['currencies'],
      currencyRates: {} as Deps['currencyRates'],
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
      rateStaleness: { fiatHours: 24, cryptoHours: 1 },
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

    const result = await runEffects(db, fullRegistry, deleteCreditCardFlow(deps, cardName));

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

describe('runEffects / runEffectsSequence — change bus publish hook (ADR-027 Phase 3)', () => {
  it('publishes the deduped entity tags of a batch that actually committed', async () => {
    const publish = vi.fn();
    const first = newAccount();
    const second = newAccount();

    const result = await runEffects(
      db,
      registry,
      () =>
        okAsync({
          persist: [
            persistence.insert({ entity: ACCOUNT_ENTITY_TAG, model: first }),
            persistence.insert({ entity: ACCOUNT_ENTITY_TAG, model: second }),
          ],
          response: null,
        }),
      publish,
    );

    expect(result.isOk()).toBe(true);
    expect(publish).toHaveBeenCalledOnce();
    expect(publish).toHaveBeenCalledWith([ACCOUNT_ENTITY_TAG]);
  });

  it('never publishes for an empty persist batch (a dry-run preview flow)', async () => {
    const publish = vi.fn();

    await runEffects(db, registry, () => okAsync({ persist: [], response: 'preview' }), publish);

    expect(publish).not.toHaveBeenCalled();
  });

  it('does not publish the entity of an idempotent-duplicate insert — nothing actually changed', async () => {
    const seed = newAccount();
    await runEffects(db, registry, insertOne(seed));

    const publish = vi.fn();
    await runEffects(db, registry, insertOne(seed), publish); // same id — no-ops

    expect(publish).not.toHaveBeenCalled();
  });

  it('publishes exactly once, on the successful attempt, after a version-conflict retry', async () => {
    const seed = newAccount();
    await runEffects(db, registry, insertOne(seed));

    const publish = vi.fn();
    let calls = 0;
    const flow = () => {
      calls += 1;
      const version = calls === 1 ? seed.version + 1 : seed.version; // stale on first attempt
      return okAsync({
        persist: [persistence.update({ entity: ACCOUNT_ENTITY_TAG, model: { ...seed, name: 'Renamed', version } })],
        response: null,
      });
    };

    const result = await runEffects(db, registry, flow, publish);

    expect(result.isOk()).toBe(true);
    expect(publish).toHaveBeenCalledOnce();
    expect(publish).toHaveBeenCalledWith([ACCOUNT_ENTITY_TAG]);
  });

  it('runEffectsSequence publishes per unit that actually commits, skipping a failed unit', async () => {
    const publish = vi.fn();
    const a1 = newAccount();
    const a3 = newAccount();
    type Unit = 'one' | 'two' | 'three';
    const flowFor = (unit: Unit) => {
      if (unit === 'two') return () => errAsync(validation(['bad line']));
      return insertOne(unit === 'one' ? a1 : a3);
    };

    const outcomes = await runEffectsSequence(db, registry, ['one', 'two', 'three'] as const, flowFor, publish);

    expect(outcomes[0]?.isOk()).toBe(true);
    expect(outcomes[1]?.isErr()).toBe(true);
    expect(outcomes[2]?.isOk()).toBe(true);
    expect(publish).toHaveBeenCalledTimes(2);
    expect(publish).toHaveBeenCalledWith([ACCOUNT_ENTITY_TAG]);
  });

  it('defaults to a no-op when publish is omitted — every existing direct caller is unaffected', async () => {
    const result = await runEffects(db, registry, insertOne(newAccount()));
    expect(result.isOk()).toBe(true);
  });
});
