import { describe, expect, it, vi } from 'vitest';
import {
  addAccountExpense,
  addAccountIncome,
  deleteAccountTransaction,
  updateAccountTransaction,
} from '../../../../src/controllers/account/transaction.js';
import type { Deps } from '../../../../src/controllers/deps.js';
import { AccountType, type Account } from '../../../../src/models/account.js';
import { CurrencyCode } from '../../../../src/models/money.js';
import type { FlowOutcome, PersistOutcome } from '../../../../src/models/persistable.js';
import { PersistOp } from '../../../../src/models/persistable.js';
import { TransactionSource, type RawTransactionView } from '../../../../src/models/transaction.js';
import { Locale } from '../../../../src/models/locale.js';

const makeDeps = (overrides: Partial<Deps> = {}): Deps => ({
  accounts: { list: async () => [], findById: async () => null } as unknown as Deps['accounts'],
  bills: {} as Deps['bills'],
  categories: {} as Deps['categories'],
  subCategories: {} as Deps['subCategories'],
  creditCards: {} as Deps['creditCards'],
  dashboards: {} as Deps['dashboards'],
  health: {} as Deps['health'],
  merchants: { matchCandidates: async () => [] } as unknown as Deps['merchants'],
  recurring: {} as Deps['recurring'],
  settings: {} as Deps['settings'],
  tags: {} as Deps['tags'],
  transactions: {} as unknown as Deps['transactions'],
  clock: () => new Date('2026-06-01'),
  newId: () => 'test-id',
  locale: async () => Locale.enum.en,
  resetLocale: vi.fn(),
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
 *  `withUnitOfWork` does post-commit, without a real database (docs/functional-core-imperative-
 *  shell.md: "Flow (core) tests assert on the returned { persist, response } — pure, no database").
 *  Deliberately sync, matching `FlowOutcome.response`'s own (sync-only) contract and
 *  `unitOfWork.ts`'s real `resolveResponse` — `withUnitOfWork` never awaits it, so a test helper
 *  that did would mask a flow accidentally returning an async response instead of failing on it. */
const resolveResponse = <T>(outcome: FlowOutcome<T>, outcomes: PersistOutcome[]): T => {
  const { response } = outcome;
  return typeof response === 'function' ? response(outcomes) : response;
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

describe('addAccountExpense — account resolution is value-based, not truthy', () => {
  it('rejects a present-but-empty account with unknown_account, not silently ignoring it', async () => {
    const deps = makeDeps();

    const result = await addAccountExpense(
      deps,
      { description: 'Test', amount: 10, account: '', idempotencyKey: 'account-empty-account' },
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
      { description: 'Card fee', amount: 5, account: 'Nubank', idempotencyKey: 'credit-post-rejected' },
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
        idempotencyKey: 'exclusive-category',
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
      { description: 'Lunch', amount: 20, account: 'Nubank', currency: 'USD', idempotencyKey: 'currency-account' },
      TransactionSource.enum.mcp,
    );

    expect(result.isOk()).toBe(true);
    const outcome = result._unsafeUnwrap();
    expect(outcome.persist).toHaveLength(1);
    expect(outcome.persist[0]).toMatchObject({ op: PersistOp.enum.insert, entity: 'transaction' });
    expect((outcome.persist[0] as { model: { currency: string } }).model.currency).toBe('BRL');
  });

  it('falls back to the input currency (default USD) when no account is given', async () => {
    const deps = makeDeps();

    const result = await addAccountExpense(
      deps,
      { description: 'Cash lunch', amount: 20, idempotencyKey: 'currency-no-account' },
      TransactionSource.enum.mcp,
    );

    expect(result.isOk()).toBe(true);
    const { model } = result._unsafeUnwrap().persist[0] as { model: { currency: string } };
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

    const result = await addAccountExpense(
      deps,
      { description: 'Uber ride', amount: 15, idempotencyKey: 'classify-auto' },
      TransactionSource.enum.mcp,
    );

    expect(result.isOk()).toBe(true);
    const { model } = result._unsafeUnwrap().persist[0] as { model: { refs: { categoryId?: string } } };
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
      { description: 'Uber ride 42', amount: 15, idempotencyKey: 'classify-merchant-key-matched' },
      TransactionSource.enum.mcp,
    );

    const { model } = result._unsafeUnwrap().persist[0] as { model: { refs: { merchantKey?: string } } };
    expect(model.refs.merchantKey).toBe('uber');
  });

  it('on no match, falls back to the full normalized description as the merchant key', async () => {
    const deps = makeDeps();

    const result = await addAccountExpense(
      deps,
      { description: 'Ze Padaria #123', amount: 15, idempotencyKey: 'classify-merchant-key-unmatched' },
      TransactionSource.enum.mcp,
    );

    expect(result._unsafeUnwrap().persist[0]).toMatchObject({
      model: { refs: { merchantKey: 'ze padaria' } },
    });
  });

  it('on a description that normalizes to nothing, leaves merchantKey undefined, not empty', async () => {
    const deps = makeDeps();

    const result = await addAccountExpense(
      deps,
      { description: '#123456', amount: 15, idempotencyKey: 'classify-merchant-key-empty' },
      TransactionSource.enum.mcp,
    );

    const { model } = result._unsafeUnwrap().persist[0] as { model: { refs: { merchantKey?: string } } };
    expect(model.refs.merchantKey).toBeUndefined();
  });

  it('sets type to income for addAccountIncome and expense for addAccountExpense', async () => {
    const deps = makeDeps();

    const expenseResult = await addAccountExpense(
      deps,
      { description: 'Groceries', amount: 30, idempotencyKey: 'type-expense' },
      TransactionSource.enum.mcp,
    );
    const incomeResult = await addAccountIncome(
      deps,
      { description: 'Salary', amount: 3000, idempotencyKey: 'type-income' },
      TransactionSource.enum.mcp,
    );

    const expenseModel = expenseResult._unsafeUnwrap().persist[0] as { model: { type: string } };
    const incomeModel = incomeResult._unsafeUnwrap().persist[0] as { model: { type: string } };
    expect(expenseModel.model.type).toBe('expense');
    expect(incomeModel.model.type).toBe('income');
  });

  it('response() reports created:true and the persisted view when the shell actually inserted the row', async () => {
    const deps = makeDeps();

    const result = await addAccountExpense(
      deps,
      { description: 'Groceries', amount: 30, idempotencyKey: 'created-true' },
      TransactionSource.enum.mcp,
    );
    const outcome = result._unsafeUnwrap();
    const { model: entity } = outcome.persist[0] as { model: MinimalEntity };

    const response = resolveResponse(outcome, [{ applied: true, read: rawViewFor(entity) }]);
    expect(response.created).toBe(true);
    expect(response.transaction.description).toBe('Groceries');
  });

  it("response() reports created:false and the EXISTING row's data on an idempotent duplicate replay", async () => {
    const deps = makeDeps();

    const result = await addAccountExpense(
      deps,
      { description: 'Groceries', amount: 30, idempotencyKey: 'created-false' },
      TransactionSource.enum.mcp,
    );
    const outcome = result._unsafeUnwrap();
    const existing = rawViewFor({
      id: 'existing-id',
      description: 'Original replay target',
      amount: 5,
      type: 'expense',
      currency: 'USD',
    });

    const response = resolveResponse(outcome, [{ applied: false, read: existing }]);
    expect(response.created).toBe(false);
    expect(response.transaction.description).toBe('Original replay target');
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
    expect(error.issues?.[0]).toContain('update_card_transaction');
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
    expect(error.issues?.[0]).toContain('delete_card_transaction');
  });

  it('updateAccountTransaction returns a version-guarded update Persistable carrying the merged patch', async () => {
    const deps = makeDeps({
      transactions: { getById: async () => baseTx } as unknown as Deps['transactions'],
    });

    const result = await updateAccountTransaction(deps, { id: 'tx-1', description: 'Updated' });

    expect(result.isOk()).toBe(true);
    const outcome = result._unsafeUnwrap();
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
    expect(outcome.persist).toHaveLength(2);
    expect(outcome.persist[1]).toEqual({
      op: PersistOp.enum.insert,
      entity: 'merchantCategory',
      model: { merchantKey: 'uber', categoryId: 'cat-new' },
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
    expect(error.issues?.[0]).toContain('cannot change the type of a transfer');
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
    expect(error.issues?.[0]).toContain('cannot have a category');
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
