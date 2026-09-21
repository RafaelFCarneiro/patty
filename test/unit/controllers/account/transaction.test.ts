import { describe, expect, it, vi } from 'vitest';
import {
  addAccountExpense,
  addAccountIncome,
  deleteAccountTransaction,
  importAccountStatement,
  updateAccountTransaction,
} from '../../../../src/controllers/account/transaction.js';
import type { Deps } from '../../../../src/controllers/deps.js';
import { toIsoDate } from '../../../../src/logic/period.js';
import { AccountType, type Account } from '../../../../src/models/account.js';
import { CurrencyCode } from '../../../../src/models/money.js';
import type { FlowOutcome, Persistable, PersistOutcome } from '../../../../src/effects/persistable.js';
import { PersistOp } from '../../../../src/effects/persistable.js';
import { TransactionSource, type RawTransactionView } from '../../../../src/models/transaction.js';
import type { ValidationError } from '../../../../src/models/error.js';
import { TRANSACTION_TAG_ENTITY_TAG } from '../../../../src/models/transactionTag.js';
import { Locale } from '../../../../src/models/locale.js';
import { SEEDED_CURRENCIES } from '../../fixtures/currencies.js';

const makeDeps = (overrides: Partial<Deps> = {}): Deps => ({
  accounts: { list: async () => [], findById: async () => null } as unknown as Deps['accounts'],
  bills: {} as Deps['bills'],
  budgets: {} as Deps['budgets'],
  categories: {} as Deps['categories'],
  subCategories: {} as Deps['subCategories'],
  correlations: {} as Deps['correlations'],
  creditCards: {} as Deps['creditCards'],
  currencies: { list: async () => SEEDED_CURRENCIES } as unknown as Deps['currencies'],
  currencyRates: {} as Deps['currencyRates'],
  dashboards: {} as Deps['dashboards'],
  health: {} as Deps['health'],
  merchants: { matchCandidates: async () => [] } as unknown as Deps['merchants'],
  recurring: {} as Deps['recurring'],
  settings: {} as Deps['settings'],
  tags: { list: async () => [] } as unknown as Deps['tags'],
  transactions: {} as unknown as Deps['transactions'],
  clock: () => new Date('2026-06-01'),
  newId: () => 'test-id',
  locale: async () => Locale.enum.en,
  rateStaleness: { fiatHours: 24, cryptoHours: 1 },
  ...overrides,
});

const account = (overrides: Partial<Account> = {}): Account => ({
  id: 'acc-1',
  name: 'Nubank',
  type: AccountType.enum.checking,
  currency: CurrencyCode.enum.BRL,
  initialBalance: 0,
  ...overrides,
});

/** Resolves a `FlowOutcome`'s `response` against synthesized apply outcomes — mirrors what
 *  `runEffects` does post-commit, without a real database (docs/functional-core-imperative-
 *  shell.md: "Flow (core) tests assert on the returned { persist, response } — pure, no database").
 *  Deliberately sync, matching `FlowOutcome.response`'s own (sync-only) contract and
 *  `effects.ts`'s real `resolveResponse` — `runEffects` never awaits it, so a test helper
 *  that did would mask a flow accidentally returning an async response instead of failing on it. */
const resolveResponse = <T>(outcome: FlowOutcome<T>, outcomes: PersistOutcome[]): T => {
  const { response } = outcome;
  return typeof response === 'function' ? (response as (outcomes: PersistOutcome[]) => T)(outcomes) : response;
};

/** A fake persisted-and-joined view — what `transactionApplier` would hand back as a
 *  `PersistOutcome.read` after insert/update, for a given entity the flow decided to persist. */
type MinimalEntity = { id: string; description: string; amount: number; type: string; currency: string };
const rawViewFor = (entity: MinimalEntity): RawTransactionView =>
  ({
    id: entity.id,
    description: entity.description,
    amount: entity.amount,
    type: entity.type,
    status: 'effective',
    date: '2026-06-01',
    currency: entity.currency,
    source: 'mcp',
    idempotencyKey: 'k',
    classification: { method: 'none', confidence: 0 },
    tags: [],
    version: 0,
  }) as RawTransactionView;

/** Locates the transaction `Persistable` in a batch by entity tag — a batch conditionally leads
 *  with a merchant insert (ADR-023 `withMerchant`), so the transaction's own entry is no longer
 *  reliably `persist[0]`. */
const findTransactionPersistable = (persist: readonly Persistable[]): Persistable => {
  const found = persist.find((p) => p.entity === 'transaction');
  if (!found) throw new Error('findTransactionPersistable: no transaction Persistable in batch');
  return found;
};

describe('addAccountExpense — account resolution is value-based, not truthy', () => {
  it('rejects a present-but-empty account with unknown_account, not silently ignoring it', async () => {
    const deps = makeDeps();

    const result = await addAccountExpense(
      deps,
      { description: 'Test', amount: 10, account: '' },
      TransactionSource.enum.mcp,
    );

    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr().code).toBe('unknown_account');
  });
});

describe('addAccountExpense / addAccountIncome — credit account rejection', () => {
  it('rejects posting directly to a credit account', async () => {
    const deps = makeDeps({
      accounts: { list: async () => [account({ type: AccountType.enum.credit })] } as unknown as Deps['accounts'],
    });

    const result = await addAccountExpense(
      deps,
      { description: 'Card fee', amount: 5, account: 'Nubank' },
      TransactionSource.enum.mcp,
    );

    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr().code).toBe('validation');
  });
});

describe('addAccountExpense / addAccountIncome — category/sub-category exclusivity', () => {
  it('rejects when both category and subCategory are provided', async () => {
    const deps = makeDeps();

    const result = await addAccountIncome(
      deps,
      {
        description: 'Salary',
        amount: 100,
        category: 'Income',
        subCategory: 'Salary',
      },
      TransactionSource.enum.mcp,
    );

    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr()).toMatchObject({
      code: 'validation',
      issues: ['provide category OR subCategory, not both — subCategory implies its parent category'],
    });
  });
});

describe('addAccountExpense — the write is returned as data, not performed (ADR-021)', () => {
  it('returns a single insert Persistable carrying the account currency, ignoring input currency', async () => {
    const deps = makeDeps({
      accounts: { list: async () => [account({ currency: 'BRL' })] } as unknown as Deps['accounts'],
    });

    const result = await addAccountExpense(
      deps,
      { description: 'Lunch', amount: 20, account: 'Nubank', currency: 'USD' },
      TransactionSource.enum.mcp,
    );

    expect(result.isOk()).toBe(true);
    const outcome = result._unsafeUnwrap();
    // 'Lunch' normalizes to a non-empty merchant key, so a merchant insert precedes it (ADR-023).
    expect(outcome.persist).toHaveLength(2);
    const tx = findTransactionPersistable(outcome.persist);
    expect(tx).toMatchObject({ op: PersistOp.enum.insert, entity: 'transaction' });
    expect((tx as { model: { currency: string } }).model.currency).toBe('BRL');
  });

  it('falls back to the input currency (default USD) when no account is given', async () => {
    const deps = makeDeps();

    const result = await addAccountExpense(deps, { description: 'Cash lunch', amount: 20 }, TransactionSource.enum.mcp);

    expect(result.isOk()).toBe(true);
    const { model } = findTransactionPersistable(result._unsafeUnwrap().persist) as { model: { currency: string } };
    expect(model.currency).toBe('USD');
  });

  it('auto-classifies via merchant matches when no category is given', async () => {
    const deps = makeDeps({
      merchants: {
        matchCandidates: async () => [
          { merchantKey: 'uber', categoryId: 'cat-transport', categoryName: 'Transport', weight: 3, origin: 'rule' },
        ],
      } as unknown as Deps['merchants'],
    });

    const result = await addAccountExpense(deps, { description: 'Uber ride', amount: 15 }, TransactionSource.enum.mcp);

    expect(result.isOk()).toBe(true);
    const { model } = findTransactionPersistable(result._unsafeUnwrap().persist) as {
      model: { refs: { categoryId?: string } };
    };
    expect(model.refs.categoryId).toBe('cat-transport');
  });

  it('on a match, stores the matched (possibly partial) merchant key, not the full description', async () => {
    const deps = makeDeps({
      merchants: {
        matchCandidates: async () => [
          { merchantKey: 'uber', categoryId: 'cat-transport', categoryName: 'Transport', weight: 3, origin: 'rule' },
        ],
      } as unknown as Deps['merchants'],
    });

    const result = await addAccountExpense(
      deps,
      { description: 'Uber ride 42', amount: 15 },
      TransactionSource.enum.mcp,
    );

    const { model } = findTransactionPersistable(result._unsafeUnwrap().persist) as {
      model: { refs: { merchantKey?: string } };
    };
    expect(model.refs.merchantKey).toBe('uber');
  });

  it('on no match, falls back to the full normalized description as the merchant key', async () => {
    const deps = makeDeps();

    const result = await addAccountExpense(
      deps,
      { description: 'Ze Padaria #123', amount: 15 },
      TransactionSource.enum.mcp,
    );

    expect(findTransactionPersistable(result._unsafeUnwrap().persist)).toMatchObject({
      model: { refs: { merchantKey: 'ze padaria' } },
    });
  });

  it('emits a merchant insert ordered before the transaction insert (rule 5 — FK order)', async () => {
    const deps = makeDeps();

    const result = await addAccountExpense(
      deps,
      { description: 'Ze Padaria #123', amount: 15 },
      TransactionSource.enum.mcp,
    );

    const { persist } = result._unsafeUnwrap();
    expect(persist).toEqual([
      { op: PersistOp.enum.insert, entity: 'merchant', model: { key: 'ze padaria' } },
      expect.objectContaining({ op: PersistOp.enum.insert, entity: 'transaction' }),
    ]);
  });

  it('on a description that normalizes to nothing, emits no merchant Persistable', async () => {
    const deps = makeDeps();

    const result = await addAccountExpense(deps, { description: '#123456', amount: 15 }, TransactionSource.enum.mcp);

    const outcome = result._unsafeUnwrap();
    expect(outcome.persist).toHaveLength(1);
    const { model } = outcome.persist[0] as { model: { refs: { merchantKey?: string } } };
    expect(model.refs.merchantKey).toBeUndefined();
  });

  it('sets type to income for addAccountIncome and expense for addAccountExpense', async () => {
    const deps = makeDeps();

    const expenseResult = await addAccountExpense(
      deps,
      { description: 'Groceries', amount: 30 },
      TransactionSource.enum.mcp,
    );
    const incomeResult = await addAccountIncome(
      deps,
      { description: 'Salary', amount: 3000 },
      TransactionSource.enum.mcp,
    );

    const expenseModel = findTransactionPersistable(expenseResult!._unsafeUnwrap().persist) as {
      model: { type: string };
    };
    const incomeModel = findTransactionPersistable(incomeResult!._unsafeUnwrap().persist) as {
      model: { type: string };
    };
    expect(expenseModel.model.type).toBe('expense');
    expect(incomeModel.model.type).toBe('income');
  });

  it('response() reports created:true and the persisted view when the shell actually inserted the row', async () => {
    const deps = makeDeps();

    const result = await addAccountExpense(deps, { description: 'Groceries', amount: 30 }, TransactionSource.enum.mcp);
    const outcome = result._unsafeUnwrap();
    const { model: entity } = findTransactionPersistable(outcome.persist) as { model: MinimalEntity };

    const response = resolveResponse(outcome, [{ entity: 'transaction', applied: true, read: rawViewFor(entity) }]);
    expect(response.created).toBe(true);
    expect(response.transaction.description).toBe('Groceries');
  });

  it("response() reports created:false and the EXISTING row's data on an idempotent duplicate replay", async () => {
    const deps = makeDeps();

    const result = await addAccountExpense(deps, { description: 'Groceries', amount: 30 }, TransactionSource.enum.mcp);
    const outcome = result._unsafeUnwrap();
    const existing = rawViewFor({
      id: 'existing-id',
      description: 'Original replay target',
      amount: 5,
      type: 'expense',
      currency: 'USD',
    });

    const response = resolveResponse(outcome, [{ entity: 'transaction', applied: false, read: existing }]);
    expect(response.created).toBe(false);
    expect(response.transaction.description).toBe('Original replay target');
  });
});

describe('addAccountExpense — tag-set resolution (ADR-023 step 2)', () => {
  it('resolves given tag names to ids against deps.tags.list(), dropping unmatched names', async () => {
    const deps = makeDeps({
      tags: {
        list: async () => [
          { id: 'tag-work', name: 'work' },
          { id: 'tag-travel', name: 'travel' },
        ],
      } as unknown as Deps['tags'],
    });

    const result = await addAccountExpense(
      deps,
      {
        description: 'Cash lunch',
        amount: 20,
        tags: ['work', 'does-not-exist'],
      },
      TransactionSource.enum.mcp,
    );

    const outcome = result._unsafeUnwrap();
    const tagSet = outcome.persist.find((p) => p.entity === TRANSACTION_TAG_ENTITY_TAG);
    expect(tagSet).toEqual({
      op: PersistOp.enum.insert,
      entity: TRANSACTION_TAG_ENTITY_TAG,
      // Addressed by the flow's own minted transaction id (makeDeps' newId stub).
      model: { transactionId: 'test-id', tagIds: ['tag-work'] },
    });
  });

  it('omitting input.tags emits no tag-set Persistable and never reads the tag catalog', async () => {
    const deps = makeDeps({
      tags: {
        list: () => {
          throw new Error('must not read the tag catalog when input.tags is omitted');
        },
      } as unknown as Deps['tags'],
    });

    const result = await addAccountExpense(deps, { description: 'Cash lunch', amount: 20 }, TransactionSource.enum.mcp);

    const outcome = result._unsafeUnwrap();
    expect(outcome.persist.some((p) => p.entity === TRANSACTION_TAG_ENTITY_TAG)).toBe(false);
  });

  it("a fresh insert's response overlays the matched tag names onto the read-back view", async () => {
    const deps = makeDeps({
      tags: { list: async () => [{ id: 'tag-travel', name: 'travel' }] } as unknown as Deps['tags'],
    });

    const result = await addAccountExpense(
      deps,
      { description: 'Groceries', amount: 30, tags: ['travel'] },
      TransactionSource.enum.mcp,
    );
    const outcome = result._unsafeUnwrap();
    const { model: entity } = findTransactionPersistable(outcome.persist) as { model: MinimalEntity };

    // The read-back runs before the tag set applies, so its view can't show the fresh links —
    // the overlay is what surfaces them. Gated on the tag set's OWN outcome, not the transaction's.
    const response = resolveResponse(outcome, [
      { entity: 'transaction', applied: true, read: rawViewFor(entity) },
      { entity: TRANSACTION_TAG_ENTITY_TAG, applied: true },
    ]);
    expect(response.created).toBe(true);
    expect(response.transaction.tags).toEqual(['travel']);
  });

  it("a duplicate replay's response keeps the surviving row's tags, not the replay's matched names", async () => {
    const deps = makeDeps({
      tags: { list: async () => [{ id: 'tag-travel', name: 'travel' }] } as unknown as Deps['tags'],
    });

    const result = await addAccountExpense(
      deps,
      { description: 'Groceries', amount: 30, tags: ['travel'] },
      TransactionSource.enum.mcp,
    );
    const outcome = result._unsafeUnwrap();
    // The shell reports the duplicate: the insert no-op'd, the replay's tag set no-op'd with it
    // (its minted id was never inserted), and the read-back view is the surviving row — whose own
    // tags are untouched (ADR-023 step 3).
    const surviving = {
      ...rawViewFor({ id: 'existing-id', description: 'Original', amount: 5, type: 'expense', currency: 'BRL' }),
      tags: ['finance'],
    };

    // The tag-set Persistable no-op'd too (the replay's minted id was never inserted) — this is
    // what the overlay gate must key off, not the transaction's own applied flag.
    const response = resolveResponse(outcome, [
      { entity: 'transaction', applied: false, read: surviving },
      { entity: TRANSACTION_TAG_ENTITY_TAG, applied: false },
    ]);
    expect(response.created).toBe(false);
    expect(response.transaction.tags).toEqual(['finance']);
  });
});

const baseTx: RawTransactionView = {
  id: 'tx-1',
  description: 'Original',
  amount: 10,
  type: 'expense',
  status: 'effective',
  date: '2026-06-01',
  currency: 'USD',
  source: 'mcp',
  idempotencyKey: 'existing-key',
  classification: { method: 'none', confidence: 0 },
  tags: [],
  version: 3,
};

const creditAccountsById = {
  findById: async () => account({ id: 'acc-card-internal', type: AccountType.enum.credit }),
};

describe('updateAccountTransaction / deleteAccountTransaction — ownership by account type (ADR-020)', () => {
  it('updateAccountTransaction rejects a tx with a credit leg, redirecting to update_card_transaction', async () => {
    const deps = makeDeps({
      transactions: {
        getById: async () => ({ ...baseTx, accountId: 'acc-card-internal' }),
      } as unknown as Deps['transactions'],
      accounts: creditAccountsById as unknown as Deps['accounts'],
    });

    const result = await updateAccountTransaction(deps, { id: 'tx-1', description: 'Changed' });

    expect(result.isErr()).toBe(true);
    const error = result._unsafeUnwrapErr();
    expect(error.code).toBe('validation');
    expect((error as ValidationError).issues[0]).toContain('update_card_transaction');
  });

  it('deleteAccountTransaction rejects a tx with a credit leg, redirecting to delete_card_transaction', async () => {
    const deps = makeDeps({
      transactions: {
        getById: async () => ({ ...baseTx, toAccountId: 'acc-card-internal', billId: 'bill-1' }),
      } as unknown as Deps['transactions'],
      accounts: creditAccountsById as unknown as Deps['accounts'],
    });

    const result = await deleteAccountTransaction(deps, { id: 'tx-1', confirm: true });

    expect(result.isErr()).toBe(true);
    const error = result._unsafeUnwrapErr();
    expect(error.code).toBe('validation');
    expect((error as ValidationError).issues[0]).toContain('delete_card_transaction');
  });

  it('updateAccountTransaction returns a version-guarded update Persistable carrying the merged patch', async () => {
    const deps = makeDeps({
      transactions: { getById: async () => baseTx } as unknown as Deps['transactions'],
    });

    const result = await updateAccountTransaction(deps, { id: 'tx-1', description: 'Updated' });

    expect(result.isOk()).toBe(true);
    const outcome = result._unsafeUnwrap();
    // input.tags omitted — no tag-set Persistable (ADR-023 step 2 leaves untouched tags alone).
    expect(outcome.persist).toHaveLength(1);
    const persisted = outcome.persist[0] as { op: string; model: { id: string; description: string; version: number } };
    expect(persisted.op).toBe(PersistOp.enum.update);
    expect(persisted.model).toMatchObject({ id: 'tx-1', description: 'Updated', version: baseTx.version });
  });

  it('updateAccountTransaction leaves fields untouched when omitted, merging onto the existing row', async () => {
    const deps = makeDeps({
      transactions: { getById: async () => baseTx } as unknown as Deps['transactions'],
    });

    const result = await updateAccountTransaction(deps, { id: 'tx-1', amount: 42 });

    const persisted = result._unsafeUnwrap().persist[0] as { model: { description: string; amount: number } };
    expect(persisted.model.description).toBe(baseTx.description);
    expect(persisted.model.amount).toBe(42);
  });

  const newCategory = { id: 'cat-new', name: 'Transporte', kind: 'both', names: null };

  it('does not append a merchant-learning Persistable when no category correction was given', async () => {
    const deps = makeDeps({
      transactions: {
        getById: async () => ({ ...baseTx, categoryId: 'cat-old', merchant: 'uber' }),
      } as unknown as Deps['transactions'],
    });

    const result = await updateAccountTransaction(deps, { id: 'tx-1', description: 'No category change' });

    expect(result._unsafeUnwrap().persist).toHaveLength(1);
  });

  it('composes a merchant-learning insert into the same atomic batch on a category correction (rule 5)', async () => {
    const deps = makeDeps({
      transactions: {
        getById: async () => ({ ...baseTx, categoryId: 'cat-old', merchant: 'uber' }),
      } as unknown as Deps['transactions'],
      categories: { list: async () => [newCategory] } as unknown as Deps['categories'],
    });

    const result = await updateAccountTransaction(deps, { id: 'tx-1', category: 'Transporte' });

    const outcome = result._unsafeUnwrap();
    // Transaction update, then a merchant insert, then the learning-edge insert (FK: merchant
    // precedes merchant_category) — both appended after the flow's own entity (rule 5).
    expect(outcome.persist).toHaveLength(3);
    expect(outcome.persist[0]).toMatchObject({ op: PersistOp.enum.update, entity: 'transaction' });
    expect(outcome.persist[1]).toEqual({
      op: PersistOp.enum.insert,
      entity: 'merchant',
      model: { key: 'uber' },
    });
    expect(outcome.persist[2]).toEqual({
      op: PersistOp.enum.insert,
      entity: 'merchantCategory',
      model: { merchantKey: 'uber', categoryId: 'cat-new', weightDelta: 1, origin: 'history' },
    });
    // response() is pure data-shaping — it must not itself perform any write.
    expect(typeof outcome.response).not.toBe('undefined');
  });

  it('does not append a merchant-learning Persistable when the transaction has no classified merchant', async () => {
    const deps = makeDeps({
      transactions: {
        getById: async () => ({ ...baseTx, categoryId: 'cat-old', merchant: undefined }),
      } as unknown as Deps['transactions'],
      categories: { list: async () => [newCategory] } as unknown as Deps['categories'],
    });

    const result = await updateAccountTransaction(deps, { id: 'tx-1', category: 'Transporte' });

    expect(result._unsafeUnwrap().persist).toHaveLength(1);
  });

  it('deleteAccountTransaction returns an empty persist batch (no writes) for a dry run without confirm', async () => {
    const deps = makeDeps({
      transactions: { getById: async () => baseTx } as unknown as Deps['transactions'],
    });

    const result = await deleteAccountTransaction(deps, { id: 'tx-1', confirm: false });

    expect(result.isOk()).toBe(true);
    const outcome = result._unsafeUnwrap();
    expect(outcome.persist).toEqual([]);
    expect(outcome.response).toMatchObject({ deleted: false, dryRun: true });
  });

  it('deleteAccountTransaction returns a version-guarded remove Persistable when confirmed', async () => {
    const deps = makeDeps({
      transactions: { getById: async () => baseTx } as unknown as Deps['transactions'],
    });

    const result = await deleteAccountTransaction(deps, { id: 'tx-1', confirm: true });

    expect(result.isOk()).toBe(true);
    const outcome = result._unsafeUnwrap();
    expect(outcome.persist).toEqual([
      { op: PersistOp.enum.delete, entity: 'transaction', id: 'tx-1', version: baseTx.version },
    ]);
    expect(outcome.response).toMatchObject({ deleted: true });
  });
});

describe('updateAccountTransaction — tag-set resolution (ADR-023 step 2)', () => {
  it('omitting input.tags emits no tag-set Persistable — existing tags are left untouched', async () => {
    const deps = makeDeps({
      transactions: { getById: async () => ({ ...baseTx, tags: ['work'] }) } as unknown as Deps['transactions'],
      tags: {
        list: () => {
          throw new Error('must not read the tag catalog when input.tags is omitted');
        },
      } as unknown as Deps['tags'],
    });

    const result = await updateAccountTransaction(deps, { id: 'tx-1', description: 'Updated' });

    const outcome = result._unsafeUnwrap();
    expect(outcome.persist.some((p) => p.entity === TRANSACTION_TAG_ENTITY_TAG)).toBe(false);
  });

  it('replaces the tag set with input.tags when given, ignoring the existing set entirely', async () => {
    const deps = makeDeps({
      transactions: { getById: async () => ({ ...baseTx, tags: ['work'] }) } as unknown as Deps['transactions'],
      tags: {
        list: async () => [
          { id: 'tag-work', name: 'work' },
          { id: 'tag-travel', name: 'travel' },
        ],
      } as unknown as Deps['tags'],
    });

    const result = await updateAccountTransaction(deps, { id: 'tx-1', tags: ['travel'] });

    const outcome = result._unsafeUnwrap();
    const tagSet = outcome.persist.find((p) => p.entity === TRANSACTION_TAG_ENTITY_TAG);
    expect(tagSet).toEqual({
      op: PersistOp.enum.insert,
      entity: TRANSACTION_TAG_ENTITY_TAG,
      model: { transactionId: 'tx-1', tagIds: ['tag-travel'] },
    });
  });

  it('an explicit empty tags array clears the set, distinct from omitting it', async () => {
    const deps = makeDeps({
      transactions: { getById: async () => ({ ...baseTx, tags: ['work'] }) } as unknown as Deps['transactions'],
      tags: { list: async () => [{ id: 'tag-work', name: 'work' }] } as unknown as Deps['tags'],
    });

    const result = await updateAccountTransaction(deps, { id: 'tx-1', tags: [] });

    const outcome = result._unsafeUnwrap();
    const tagSet = outcome.persist.find((p) => p.entity === TRANSACTION_TAG_ENTITY_TAG);
    expect(tagSet).toEqual({
      op: PersistOp.enum.insert,
      entity: TRANSACTION_TAG_ENTITY_TAG,
      model: { transactionId: 'tx-1', tagIds: [] },
    });
  });
});

describe('updateAccountTransaction — transfer mutability (ADR-020 §4, moved from the core)', () => {
  const transferTx: RawTransactionView = {
    ...baseTx,
    type: 'transfer',
    accountId: 'acc-bank',
    toAccountId: 'acc-other',
  };
  const transferLegAccountsById: Record<string, Account> = {
    'acc-bank': account({ id: 'acc-bank' }),
    'acc-other': account({ id: 'acc-other' }),
  };
  const transferLegAccounts = { findById: async (id: string) => transferLegAccountsById[id] ?? null };

  it('rejects changing the type of a transfer', async () => {
    const deps = makeDeps({
      transactions: { getById: async () => transferTx } as unknown as Deps['transactions'],
      accounts: transferLegAccounts as unknown as Deps['accounts'],
    });

    const result = await updateAccountTransaction(deps, { id: 'tx-1', type: 'expense' });

    expect(result.isErr()).toBe(true);
    const error = result._unsafeUnwrapErr();
    expect(error.code).toBe('validation');
    expect((error as ValidationError).issues[0]).toContain('cannot change the type of a transfer');
  });

  it('rejects setting a category on a transfer', async () => {
    const deps = makeDeps({
      transactions: { getById: async () => transferTx } as unknown as Deps['transactions'],
      accounts: transferLegAccounts as unknown as Deps['accounts'],
    });

    const result = await updateAccountTransaction(deps, { id: 'tx-1', category: 'Transporte' });

    expect(result.isErr()).toBe(true);
    const error = result._unsafeUnwrapErr();
    expect(error.code).toBe('validation');
    expect((error as ValidationError).issues[0]).toContain('cannot have a category');
  });

  it('allows a non-category, non-type update on a transfer (e.g. amount), preserving its type', async () => {
    const deps = makeDeps({
      transactions: { getById: async () => transferTx } as unknown as Deps['transactions'],
      accounts: transferLegAccounts as unknown as Deps['accounts'],
    });

    const result = await updateAccountTransaction(deps, { id: 'tx-1', amount: 50 });

    expect(result.isOk()).toBe(true);
    const persisted = result._unsafeUnwrap().persist[0] as { model: { type: string; amount: number } };
    expect(persisted.model.type).toBe('transfer');
    expect(persisted.model.amount).toBe(50);
  });
});

/** The derived idempotencyKey off the transaction Persistable a flow's outcome carries. */
const idempotencyKeyOf = (outcome: FlowOutcome<unknown>): string =>
  (findTransactionPersistable(outcome.persist) as { idempotencyKey: string }).idempotencyKey;

describe('importAccountStatement — pure per-line plan for the shell', () => {
  it("defaults every line's date, stamps rawInput onto each, and carries discriminator through", async () => {
    const clock = new Date('2026-06-01');
    const deps = makeDeps({
      clock: () => clock,
      accounts: { list: async () => [account()] } as unknown as Deps['accounts'],
    });

    const plan = await importAccountStatement(
      deps,
      {
        account: 'Nubank',
        items: [
          { description: 'iFood', amount: 45, type: 'expense' },
          { description: 'Salary', amount: 5000, type: 'income', date: '2026-05-01', discriminator: 'explicit' },
        ],
        rawInput: 'pasted statement text',
      },
      TransactionSource.enum.import,
    );

    expect(plan.lines).toHaveLength(2);
    expect(plan.lines[0]).toMatchObject({ date: toIsoDate(clock), rawInput: 'pasted statement text' });
    expect(plan.lines[1]).toMatchObject({ date: '2026-05-01', discriminator: 'explicit' });
  });

  it("routes an 'expense' line through addAccountExpense, an 'income' one through addAccountIncome", async () => {
    const deps = makeDeps({
      accounts: { list: async () => [account()] } as unknown as Deps['accounts'],
    });

    const plan = await importAccountStatement(
      deps,
      {
        account: 'Nubank',
        items: [
          { description: 'iFood', amount: 45, type: 'expense', date: '2026-06-01' },
          { description: 'Salary', amount: 5000, type: 'income', date: '2026-06-01' },
        ],
      },
      TransactionSource.enum.import,
    );

    const [expenseResult, incomeResult] = await Promise.all(plan.lines.map((line) => plan.flowFor(line)()));

    expect(expenseResult!.isOk()).toBe(true);
    const expenseModel = (
      findTransactionPersistable(expenseResult!._unsafeUnwrap().persist) as {
        model: { type: string };
      }
    ).model;
    expect(expenseModel.type).toBe('expense');

    expect(incomeResult!.isOk()).toBe(true);
    const incomeModel = (
      findTransactionPersistable(incomeResult!._unsafeUnwrap().persist) as {
        model: { type: string };
      }
    ).model;
    expect(incomeModel.type).toBe('income');
  });

  it("binds every line to the statement's fixed account, not a per-line one", async () => {
    const deps = makeDeps({
      accounts: { list: async () => [account({ name: 'Nubank' })] } as unknown as Deps['accounts'],
    });

    const plan = await importAccountStatement(
      deps,
      {
        account: 'Nubank',
        items: [{ description: 'iFood', amount: 45, type: 'expense', date: '2026-06-01' }],
      },
      TransactionSource.enum.import,
    );

    const result = await plan.flowFor(plan.lines[0]!)();

    expect(result.isOk()).toBe(true);
    const model = (
      findTransactionPersistable(result._unsafeUnwrap().persist) as {
        model: { refs: { accountId?: string } };
      }
    ).model;
    expect(model.refs.accountId).toBe('acc-1');
  });

  it("resolves the account's currency decimals for the idempotency key, keeping BTC lines distinct", async () => {
    const deps = makeDeps({
      accounts: { list: async () => [account({ currency: CurrencyCode.enum.BTC })] } as unknown as Deps['accounts'],
    });

    const plan = await importAccountStatement(
      deps,
      {
        account: 'Nubank',
        items: [
          { description: 'BTC buy', amount: 0.12345671, type: 'expense' },
          { description: 'BTC buy', amount: 0.12345679, type: 'expense' },
        ],
      },
      TransactionSource.enum.import,
    );

    const [first, second] = await Promise.all(plan.lines.map((line) => plan.flowFor(line)()));
    expect(idempotencyKeyOf(first!._unsafeUnwrap())).not.toBe(idempotencyKeyOf(second!._unsafeUnwrap()));
  });

  it('builds a valid plan when the account name does not resolve — the line reports notFound on its own', async () => {
    const deps = makeDeps({
      accounts: { list: async () => [] } as unknown as Deps['accounts'],
    });

    const plan = await importAccountStatement(
      deps,
      { account: 'Nonexistent', items: [{ description: 'iFood', amount: 45, type: 'expense' }] },
      TransactionSource.enum.import,
    );

    expect(plan.lines).toHaveLength(1);
    const result = await plan.flowFor(plan.lines[0]!)();
    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr().code).toBe('unknown_account');
  });

  it(
    'defaults to USD (2-decimal) rounding for an unattached (no-account) statement — two amounts ' +
      'differing only past 2 decimals collide',
    async () => {
      const deps = makeDeps();

      const plan = await importAccountStatement(
        deps,
        {
          items: [
            { description: 'Cash spend', amount: 5.991, type: 'expense' },
            { description: 'Cash spend', amount: 5.994, type: 'expense' },
          ],
        },
        TransactionSource.enum.import,
      );

      const [first, second] = await Promise.all(plan.lines.map((line) => plan.flowFor(line)()));
      expect(idempotencyKeyOf(first!._unsafeUnwrap())).toBe(idempotencyKeyOf(second!._unsafeUnwrap()));
    },
  );

  it(
    'an unattached statement whose lines override currency per item (#184) still resolves EACH ' +
      "line's own decimals — two per-item-BTC lines differing only past the 8th decimal stay distinct",
    async () => {
      const deps = makeDeps();

      const plan = await importAccountStatement(
        deps,
        {
          items: [
            { description: 'BTC buy', amount: 0.12345671, type: 'expense', currency: CurrencyCode.enum.BTC },
            { description: 'BTC buy', amount: 0.12345679, type: 'expense', currency: CurrencyCode.enum.BTC },
          ],
        },
        TransactionSource.enum.import,
      );

      const [first, second] = await Promise.all(plan.lines.map((line) => plan.flowFor(line)()));
      expect(idempotencyKeyOf(first!._unsafeUnwrap())).not.toBe(idempotencyKeyOf(second!._unsafeUnwrap()));
    },
  );
});
