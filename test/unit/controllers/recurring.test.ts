import { describe, expect, it, vi } from 'vitest';
import { applyDueRecurring, createRecurring } from '../../../src/controllers/recurring.js';
import type { Deps } from '../../../src/controllers/deps.js';
import { AccountType, type Account } from '../../../src/models/account.js';
import { CategoryKind, type Category } from '../../../src/models/category.js';
import { CurrencyCode } from '../../../src/models/money.js';
import { Locale } from '../../../src/models/locale.js';
import { PersistOp, type FlowOutcome, type PersistOutcome } from '@rfc0/effect-runner';
import { MERCHANT_ENTITY_TAG } from '../../../src/models/merchant.js';
import { RECURRING_ENTITY_TAG, type RecurringRuleEntity } from '../../../src/models/recurring.js';
import { TRANSACTION_ENTITY_TAG, type RawTransactionView } from '../../../src/models/transaction.js';

const makeDeps = (overrides: Partial<Deps> = {}): Deps => ({
  accounts: { list: async () => [] } as unknown as Deps['accounts'],
  bills: {} as Deps['bills'],
  budgets: {} as Deps['budgets'],
  categories: { list: async () => [] } as unknown as Deps['categories'],
  subCategories: {} as Deps['subCategories'],
  correlations: {} as Deps['correlations'],
  creditCards: {} as Deps['creditCards'],
  currencies: {} as Deps['currencies'],
  currencyRates: {} as Deps['currencyRates'],
  dashboards: {} as Deps['dashboards'],
  health: {} as Deps['health'],
  instance: {} as Deps['instance'],
  merchants: { matchCandidates: async () => [] } as unknown as Deps['merchants'],
  recurring: { due: async () => [] } as unknown as Deps['recurring'],
  settings: {} as Deps['settings'],
  tags: {} as Deps['tags'],
  transactions: {} as Deps['transactions'],
  clock: () => new Date('2026-06-01'),
  newId: () => 'new-id',
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

const category = (overrides: Partial<Category> = {}): Category => ({
  id: 'cat-1',
  name: 'Subscriptions',
  kind: CategoryKind.enum.expense,
  names: null,
  ...overrides,
});

/** Mirrors `runEffects`'s own `resolveResponse` — pure, no database (docs/functional-core-
 *  imperative-shell.md: flow tests assert on `{ persist, response }`). */
const resolveResponse = <T>(outcome: FlowOutcome<T>, outcomes: PersistOutcome[]): T => {
  const { response } = outcome;
  return typeof response === 'function' ? (response as (outcomes: PersistOutcome[]) => T)(outcomes) : response;
};

describe('createRecurring — functional core (ADR-021 phase 3b)', () => {
  it('returns a merchant insert plus the rule insert, with resolved account/category ids — no version', async () => {
    const deps = makeDeps({
      accounts: { list: async () => [account()] } as unknown as Deps['accounts'],
      categories: { list: async () => [category()] } as unknown as Deps['categories'],
    });

    const result = await createRecurring(deps, {
      description: 'Spotify',
      amount: 21.9,
      type: 'expense',
      period: 'monthly',
      startDate: '2026-07-01',
      account: 'Nubank',
      category: 'Subscriptions',
    });

    expect(result.isOk()).toBe(true);
    const outcome = result._unsafeUnwrap();
    expect(outcome.persist).toEqual([
      {
        op: PersistOp.enum.insert,
        entity: MERCHANT_ENTITY_TAG,
        model: { key: 'spotify' },
      },
      {
        op: PersistOp.enum.insert,
        entity: RECURRING_ENTITY_TAG,
        model: {
          id: 'new-id',
          description: 'Spotify',
          amount: 21.9,
          type: 'expense',
          period: 'monthly',
          nextDue: '2026-07-01',
          currency: CurrencyCode.enum.BRL,
          accountId: 'acc-1',
          categoryId: 'cat-1',
          merchantKey: 'spotify',
        },
      },
    ]);
    expect(outcome.persist[1]).not.toHaveProperty('model.version');
  });

  it('uses the explicit merchant, normalized, over the description, when both are given', async () => {
    const deps = makeDeps();

    const result = await createRecurring(deps, {
      description: 'Monthly rent payment',
      amount: 2000,
      type: 'expense',
      period: 'monthly',
      startDate: '2026-07-01',
      merchant: 'Landlord LLC',
    });

    const outcome = result._unsafeUnwrap();
    const rule = outcome.persist.find((p) => p.entity === RECURRING_ENTITY_TAG);
    expect(rule).toMatchObject({ model: { merchantKey: 'landlord llc' } });
  });

  it('reuses an already-learned merchant_category key over the full normalized description', async () => {
    const deps = makeDeps({
      merchants: {
        matchCandidates: async () => [
          { merchantKey: 'netflix', categoryId: 'cat-1', categoryName: 'Subscriptions', weight: 3, origin: 'rule' },
        ],
      } as unknown as Deps['merchants'],
    });

    const result = await createRecurring(deps, {
      description: 'Netflix.com subscription',
      amount: 39.9,
      type: 'expense',
      period: 'monthly',
      startDate: '2026-07-01',
    });

    const rule = result._unsafeUnwrap().persist.find((p) => p.entity === RECURRING_ENTITY_TAG);
    expect(rule).toMatchObject({ model: { merchantKey: 'netflix' } });
  });

  it('an explicit merchant is stored as-is, without consulting matchCandidates', async () => {
    const matchCandidates = vi.fn(async () => [
      { merchantKey: 'other-key', categoryId: 'cat-1', categoryName: 'Subscriptions', weight: 3, origin: 'rule' },
    ]);
    const deps = makeDeps({ merchants: { matchCandidates } as unknown as Deps['merchants'] });

    const result = await createRecurring(deps, {
      description: 'Netflix.com subscription',
      amount: 39.9,
      type: 'expense',
      period: 'monthly',
      startDate: '2026-07-01',
      merchant: 'Netflix',
    });

    const rule = result._unsafeUnwrap().persist.find((p) => p.entity === RECURRING_ENTITY_TAG);
    expect(rule).toMatchObject({ model: { merchantKey: 'netflix' } });
    expect(matchCandidates).not.toHaveBeenCalled();
  });

  it('leaves merchantKey unset when the description normalizes to an empty string', async () => {
    const deps = makeDeps();

    const result = await createRecurring(deps, {
      description: '123',
      amount: 10,
      type: 'expense',
      period: 'monthly',
      startDate: '2026-07-01',
    });

    const outcome = result._unsafeUnwrap();
    expect(outcome.persist).toHaveLength(1);
    expect(outcome.persist[0]).toMatchObject({ entity: RECURRING_ENTITY_TAG, model: { merchantKey: undefined } });
  });

  it('the response carries the already-resolved account/category names — no read-back', async () => {
    const deps = makeDeps({
      accounts: { list: async () => [account()] } as unknown as Deps['accounts'],
      categories: { list: async () => [category()] } as unknown as Deps['categories'],
    });

    const result = await createRecurring(deps, {
      description: 'Spotify',
      amount: 21.9,
      type: 'expense',
      period: 'monthly',
      startDate: '2026-07-01',
      account: 'Nubank',
      category: 'Subscriptions',
    });

    const outcome = result._unsafeUnwrap();
    expect(outcome.response).toMatchObject({ accountName: 'Nubank', categoryName: 'Subscriptions' });
  });

  it('defaults currency to USD when no account is linked', async () => {
    const deps = makeDeps();

    const result = await createRecurring(deps, {
      description: 'No-account rule',
      amount: 50,
      type: 'expense',
      period: 'monthly',
      startDate: '2026-07-01',
    });

    const rule = result._unsafeUnwrap().persist.find((p) => p.entity === RECURRING_ENTITY_TAG);
    expect(rule).toMatchObject({ model: { currency: CurrencyCode.enum.USD } });
  });

  it('rejects an unknown account without building any Persistable', async () => {
    const deps = makeDeps();

    const result = await createRecurring(deps, {
      description: 'Rent',
      amount: 2000,
      type: 'expense',
      period: 'monthly',
      startDate: '2026-07-01',
      account: 'Nonexistent',
    });

    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr().code).toBe('unknown_account');
  });
});

const rule = (overrides: Partial<RecurringRuleEntity> = {}): RecurringRuleEntity => ({
  id: 'rec-1',
  description: 'Rent',
  amount: 1000,
  type: 'expense',
  period: 'monthly',
  nextDue: '2026-05-01',
  currency: CurrencyCode.enum.BRL,
  accountId: 'acc-1',
  categoryId: 'cat-1',
  merchantKey: 'landlord',
  version: 2,
  ...overrides,
});

const rawViewFor = (id: string, description: string): RawTransactionView =>
  ({
    id,
    description,
    amount: 1000,
    type: 'expense',
    status: 'effective',
    date: '2026-05-01',
    currency: 'BRL',
    source: 'mcp',
    idempotencyKey: `rec-rec-1-2026-05-01`,
    classification: { method: 'user', confidence: 1 },
    tags: [],
    version: 0,
  }) as RawTransactionView;

describe('applyDueRecurring — functional core (ADR-021 phase 3b)', () => {
  it('returns no writes and an empty result when no rule is due', async () => {
    const deps = makeDeps();

    const result = await applyDueRecurring(deps);

    expect(result.isOk()).toBe(true);
    const outcome = result._unsafeUnwrap();
    expect(outcome.persist).toEqual([]);
    expect(resolveResponse(outcome, [])).toEqual({ applied: [], count: 0 });
  });

  it('emits one occurrence insert plus a version-guarded advance for a single due rule', async () => {
    const deps = makeDeps({ recurring: { due: async () => [rule()] } as unknown as Deps['recurring'] });

    const result = await applyDueRecurring(deps, { through: '2026-05-01' });

    expect(result.isOk()).toBe(true);
    const outcome = result._unsafeUnwrap();
    expect(outcome.persist).toHaveLength(2);

    const [insertTx, advance] = outcome.persist;
    expect(insertTx).toMatchObject({
      op: PersistOp.enum.insert,
      entity: TRANSACTION_ENTITY_TAG,
      idempotencyKey: 'rec-rec-1-2026-05-01',
      model: {
        description: 'Rent',
        amount: 1000,
        date: '2026-05-01',
        refs: { accountId: 'acc-1', categoryId: 'cat-1', merchantKey: 'landlord' },
      },
    });
    expect(advance).toEqual({
      op: PersistOp.enum.update,
      entity: RECURRING_ENTITY_TAG,
      model: { ...rule(), nextDue: '2026-06-01' },
    });
  });

  it('response() reports only the newly-created occurrences, keyed off the shell outcomes', async () => {
    const deps = makeDeps({ recurring: { due: async () => [rule()] } as unknown as Deps['recurring'] });

    const result = await applyDueRecurring(deps, { through: '2026-05-01' });
    const outcome = result._unsafeUnwrap();

    const response = resolveResponse(outcome, [
      { entity: TRANSACTION_ENTITY_TAG, applied: true, read: rawViewFor('tx-new', 'Rent') },
      { entity: RECURRING_ENTITY_TAG, applied: true },
    ]);
    expect(response.count).toBe(1);
    expect(response.applied).toEqual([
      { rule: 'Rent', date: '2026-05-01', transaction: expect.objectContaining({ id: 'tx-new' }) },
    ]);
  });

  it('an idempotent replay (shell reports applied:false) yields count:0 — never faked by the domain', async () => {
    const deps = makeDeps({ recurring: { due: async () => [rule()] } as unknown as Deps['recurring'] });

    const result = await applyDueRecurring(deps, { through: '2026-05-01' });
    const outcome = result._unsafeUnwrap();

    const response = resolveResponse(outcome, [
      { entity: TRANSACTION_ENTITY_TAG, applied: false, read: rawViewFor('tx-existing', 'Rent') },
      { entity: RECURRING_ENTITY_TAG, applied: true },
    ]);
    expect(response.count).toBe(0);
    expect(response.applied).toEqual([]);
  });

  it('always advances even when nothing new was materialized (mirrors pre-ADR-021 behavior)', async () => {
    const deps = makeDeps({ recurring: { due: async () => [rule()] } as unknown as Deps['recurring'] });

    const result = await applyDueRecurring(deps, { through: '2026-05-01' });
    const outcome = result._unsafeUnwrap();

    const advance = outcome.persist.find((p) => p.entity === RECURRING_ENTITY_TAG);
    expect(advance).toBeDefined();
  });

  it('materializes multiple occurrences up to `through`, one insert per due date', async () => {
    const deps = makeDeps({
      recurring: { due: async () => [rule({ nextDue: '2026-03-01' })] } as unknown as Deps['recurring'],
    });

    const result = await applyDueRecurring(deps, { through: '2026-05-01' });
    const outcome = result._unsafeUnwrap();

    const inserts = outcome.persist.filter((p) => p.entity === TRANSACTION_ENTITY_TAG);
    expect(inserts.map((p) => (p as { model: { date: string } }).model.date)).toEqual([
      '2026-03-01',
      '2026-04-01',
      '2026-05-01',
    ]);
    const advance = outcome.persist.find((p) => p.entity === RECURRING_ENTITY_TAG);
    expect(advance).toMatchObject({ model: { nextDue: '2026-06-01' } });
  });

  it('batches every due rule together — occurrences first, advances last, positionally matching outcomes', async () => {
    const deps = makeDeps({
      recurring: {
        due: async () => [
          rule({ id: 'rec-1', description: 'Rent', version: 1 }),
          rule({ id: 'rec-2', description: 'Internet', nextDue: '2026-05-01', version: 5 }),
        ],
      } as unknown as Deps['recurring'],
    });

    const result = await applyDueRecurring(deps, { through: '2026-05-01' });
    const outcome = result._unsafeUnwrap();

    // Two single-occurrence rules: 2 inserts followed by 2 advances.
    expect(outcome.persist.map((p) => p.entity)).toEqual([
      TRANSACTION_ENTITY_TAG,
      TRANSACTION_ENTITY_TAG,
      RECURRING_ENTITY_TAG,
      RECURRING_ENTITY_TAG,
    ]);

    const response = resolveResponse(outcome, [
      { entity: TRANSACTION_ENTITY_TAG, applied: true, read: rawViewFor('tx-rent', 'Rent') },
      { entity: TRANSACTION_ENTITY_TAG, applied: true, read: rawViewFor('tx-internet', 'Internet') },
      { entity: RECURRING_ENTITY_TAG, applied: true },
      { entity: RECURRING_ENTITY_TAG, applied: true },
    ]);
    expect(response.count).toBe(2);
    expect(response.applied.map((a) => a.rule)).toEqual(['Rent', 'Internet']);
  });
});
