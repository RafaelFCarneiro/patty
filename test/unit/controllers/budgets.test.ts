import { describe, expect, it } from 'vitest';
import {
  createBudget,
  deleteBudget,
  getBudgetStatus,
  listBudgets,
  updateBudget,
} from '../../../src/controllers/budgets.js';
import type { Deps } from '../../../src/controllers/deps.js';
import {
  BUDGET_ENTITY_TAG,
  BudgetPeriod,
  type BudgetEntity,
  type BudgetView,
  type BudgetViewInput,
} from '../../../src/models/budget.js';
import type { Category, SubCategory } from '../../../src/models/category.js';
import { CategoryKind } from '../../../src/models/category.js';
import type { CurrencyRateEntity } from '../../../src/models/currencyRate.js';
import { Locale } from '../../../src/models/locale.js';
import { CurrencyCode, type Currency } from '../../../src/models/money.js';
import { PersistOp } from '../../../src/models/persistable.js';
import type { CategorySpend } from '../../../src/models/transaction.js';

const foodCategory: Category = { id: 'cat-food', name: 'Food', kind: CategoryKind.enum.expense, names: null };
const salaryCategory: Category = { id: 'cat-salary', name: 'Salary', kind: CategoryKind.enum.income, names: null };
const restaurantsSubCategory: SubCategory = {
  id: 'sub-restaurants',
  name: 'Restaurants',
  parentId: 'cat-food',
  parentName: 'Food',
  kind: CategoryKind.enum.expense,
};

const makeDeps = (overrides: Partial<Deps> = {}): Deps => ({
  accounts: {} as Deps['accounts'],
  bills: {} as Deps['bills'],
  budgets: {
    findByTarget: async () => false,
    findById: async () => null,
    list: async () => [],
  } as unknown as Deps['budgets'],
  categories: { list: async () => [foodCategory, salaryCategory] } as unknown as Deps['categories'],
  subCategories: { list: async () => [restaurantsSubCategory] } as unknown as Deps['subCategories'],
  correlations: {} as Deps['correlations'],
  creditCards: {} as Deps['creditCards'],
  currencies: {} as Deps['currencies'],
  currencyRates: {} as Deps['currencyRates'],
  dashboards: {} as Deps['dashboards'],
  health: {} as Deps['health'],
  merchants: {} as Deps['merchants'],
  recurring: {} as Deps['recurring'],
  settings: {} as Deps['settings'],
  tags: {} as Deps['tags'],
  transactions: {} as Deps['transactions'],
  clock: () => new Date('2026-07-01'),
  newId: () => 'budget-id-1',
  locale: async () => Locale.enum.en,
  rateStaleness: { fiatHours: 24, cryptoHours: 1 },
  ...overrides,
});

const budgetEntity = (overrides: Partial<BudgetEntity> = {}): BudgetEntity => ({
  id: 'budget-existing',
  categoryId: 'cat-food',
  currency: CurrencyCode.enum.BRL,
  limit: 500,
  period: BudgetPeriod.enum.monthly,
  version: 2,
  ...overrides,
});

describe('createBudget — functional core', () => {
  it('resolves a top-level category target and returns an insert Persistable', async () => {
    const deps = makeDeps();

    const result = await createBudget(deps, {
      category: 'Food',
      currency: CurrencyCode.enum.BRL,
      limit: 500,
      period: BudgetPeriod.enum.monthly,
    });

    expect(result.isOk()).toBe(true);
    const outcome = result._unsafeUnwrap();
    expect(outcome.persist).toEqual([
      {
        op: PersistOp.enum.insert,
        entity: BUDGET_ENTITY_TAG,
        model: {
          id: 'budget-id-1',
          categoryId: 'cat-food',
          currency: CurrencyCode.enum.BRL,
          limit: 500,
          period: BudgetPeriod.enum.monthly,
        },
      },
    ]);
    expect(outcome.response).toEqual({
      id: 'budget-id-1',
      category: 'Food',
      currency: CurrencyCode.enum.BRL,
      limit: 500,
      period: BudgetPeriod.enum.monthly,
    } satisfies BudgetView);
  });

  it('resolves a sub-category target, storing the sub-category id and reporting both names', async () => {
    const deps = makeDeps();

    const result = await createBudget(deps, {
      subCategory: 'Restaurants',
      currency: CurrencyCode.enum.BRL,
      limit: 200,
      period: BudgetPeriod.enum.monthly,
    });

    expect(result.isOk()).toBe(true);
    const outcome = result._unsafeUnwrap();
    expect(outcome.persist).toEqual([
      {
        op: PersistOp.enum.insert,
        entity: BUDGET_ENTITY_TAG,
        model: {
          id: 'budget-id-1',
          categoryId: 'sub-restaurants',
          currency: CurrencyCode.enum.BRL,
          limit: 200,
          period: BudgetPeriod.enum.monthly,
        },
      },
    ]);
    expect(outcome.response).toEqual({
      id: 'budget-id-1',
      category: 'Food',
      subCategory: 'Restaurants',
      currency: CurrencyCode.enum.BRL,
      limit: 200,
      period: BudgetPeriod.enum.monthly,
    } satisfies BudgetView);
  });

  it('rejects when neither category nor subCategory is given', async () => {
    const deps = makeDeps();
    const result = await createBudget(deps, {
      currency: CurrencyCode.enum.BRL,
      limit: 500,
      period: BudgetPeriod.enum.monthly,
    });
    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr()).toEqual({
      code: 'validation',
      issues: ['exactly one of category or subCategory is required'],
    });
  });

  it('rejects when both category and subCategory are given', async () => {
    const deps = makeDeps();
    const result = await createBudget(deps, {
      category: 'Food',
      subCategory: 'Restaurants',
      currency: CurrencyCode.enum.BRL,
      limit: 500,
      period: BudgetPeriod.enum.monthly,
    });
    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr()).toEqual({
      code: 'validation',
      issues: ['exactly one of category or subCategory is required'],
    });
  });

  it('passes through the unknown_category resolve error for an unmatched name', async () => {
    const deps = makeDeps();
    const result = await createBudget(deps, {
      category: 'Nope',
      currency: CurrencyCode.enum.BRL,
      limit: 500,
      period: BudgetPeriod.enum.monthly,
    });
    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr()).toMatchObject({ code: 'unknown_category', query: 'Nope' });
  });

  it('rejects an income-kind category before building any Persistable', async () => {
    const deps = makeDeps();
    const result = await createBudget(deps, {
      category: 'Salary',
      currency: CurrencyCode.enum.BRL,
      limit: 500,
      period: BudgetPeriod.enum.monthly,
    });
    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr()).toEqual({ code: 'not_expense_category', category: 'Salary' });
  });

  it('rejects a duplicate (target, currency, period)', async () => {
    const deps = makeDeps({ budgets: { findByTarget: async () => true } as unknown as Deps['budgets'] });
    const result = await createBudget(deps, {
      category: 'Food',
      currency: CurrencyCode.enum.BRL,
      limit: 500,
      period: BudgetPeriod.enum.monthly,
    });
    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr()).toEqual({
      code: 'duplicate_budget',
      category: 'Food',
      subCategory: undefined,
      currency: CurrencyCode.enum.BRL,
      period: BudgetPeriod.enum.monthly,
    });
  });
});

describe('updateBudget — functional core', () => {
  it('returns a version-guarded update Persistable when the limit changes', async () => {
    const deps = makeDeps({
      budgets: { findById: async () => budgetEntity() } as unknown as Deps['budgets'],
    });

    const result = await updateBudget(deps, { id: 'budget-existing', limit: 700 });

    expect(result.isOk()).toBe(true);
    const outcome = result._unsafeUnwrap();
    expect(outcome.persist).toEqual([
      {
        op: PersistOp.enum.update,
        entity: BUDGET_ENTITY_TAG,
        model: { ...budgetEntity(), limit: 700 },
      },
    ]);
    expect(outcome.response).toEqual({
      id: 'budget-existing',
      category: 'Food',
      currency: CurrencyCode.enum.BRL,
      limit: 700,
      period: BudgetPeriod.enum.monthly,
    } satisfies BudgetView);
  });

  it('localizes the category name off deps.categories.list() for the resolved locale', async () => {
    const foodCategoryPt: Category = {
      id: 'cat-food',
      name: 'Food',
      kind: CategoryKind.enum.expense,
      names: { pt: 'Comida' },
    };
    const deps = makeDeps({
      budgets: { findById: async () => budgetEntity() } as unknown as Deps['budgets'],
      categories: { list: async () => [foodCategoryPt, salaryCategory] } as unknown as Deps['categories'],
      locale: async () => Locale.enum.pt,
    });

    const result = await updateBudget(deps, { id: 'budget-existing', limit: 700 });

    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap().response).toMatchObject({ category: 'Comida' });
  });

  it('no-ops when nothing actually changes', async () => {
    const deps = makeDeps({
      budgets: { findById: async () => budgetEntity() } as unknown as Deps['budgets'],
    });

    const result = await updateBudget(deps, { id: 'budget-existing', limit: 500 });

    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap().persist).toEqual([]);
  });

  it('reports unknown_budget for a missing id', async () => {
    const deps = makeDeps({ budgets: { findById: async () => null } as unknown as Deps['budgets'] });
    const result = await updateBudget(deps, { id: 'nonexistent', limit: 700 });
    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr()).toEqual({ code: 'unknown_budget', query: 'nonexistent', candidates: [] });
  });

  it('reports unknown_category if the stored categoryId matches no category or sub-category', async () => {
    // Can't happen under the FK-enforced invariant (a stored categoryId always references a live
    // node) — this only exercises describeCategoryTarget's own mapped-error fallback.
    const deps = makeDeps({
      budgets: { findById: async () => budgetEntity({ categoryId: 'cat-ghost' }) } as unknown as Deps['budgets'],
    });
    const result = await updateBudget(deps, { id: 'budget-existing', limit: 700 });
    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr()).toEqual({ code: 'unknown_category', query: 'cat-ghost', candidates: [] });
  });
});

describe('deleteBudget — functional core', () => {
  it('returns a version-guarded remove Persistable when the budget exists', async () => {
    const deps = makeDeps({
      budgets: { findById: async () => budgetEntity() } as unknown as Deps['budgets'],
    });

    const result = await deleteBudget(deps, 'budget-existing');

    expect(result.isOk()).toBe(true);
    const outcome = result._unsafeUnwrap();
    expect(outcome.persist).toEqual([
      { op: PersistOp.enum.delete, entity: BUDGET_ENTITY_TAG, id: 'budget-existing', version: 2 },
    ]);
    expect(outcome.response).toEqual({ deleted: true });
  });

  it('returns deleted:false with an empty batch when the id does not exist', async () => {
    const deps = makeDeps({ budgets: { findById: async () => null } as unknown as Deps['budgets'] });
    const result = await deleteBudget(deps, 'nonexistent');
    expect(result.isOk()).toBe(true);
    const outcome = result._unsafeUnwrap();
    expect(outcome.persist).toEqual([]);
    expect(outcome.response).toEqual({ deleted: false });
  });
});

const budgetViewRow = (overrides: Partial<BudgetViewInput> = {}): BudgetViewInput => ({
  id: 'budget-1',
  currency: CurrencyCode.enum.BRL,
  limit: 500,
  period: BudgetPeriod.enum.monthly,
  targetId: 'cat-food',
  nodeName: 'Food',
  nodeNames: null,
  nodeParentId: null,
  parentName: null,
  parentNames: null,
  ...overrides,
});

describe('listBudgets', () => {
  it('delegates to the repo, localizing the raw name+names row for the locale', async () => {
    const row = budgetViewRow({ nodeNames: { pt: 'Comida' } });
    const deps = makeDeps({
      budgets: { list: async () => [row] } as unknown as Deps['budgets'],
      locale: async () => Locale.enum.pt,
    });
    expect(await listBudgets(deps)).toEqual([
      {
        id: 'budget-1',
        category: 'Comida',
        subCategory: undefined,
        currency: CurrencyCode.enum.BRL,
        limit: 500,
        period: BudgetPeriod.enum.monthly,
      },
    ] satisfies BudgetView[]);
  });
});

describe('getBudgetStatus', () => {
  it('converts month/year to the [from, to) range for spendByCategory, and correlates the result', async () => {
    const row = budgetViewRow();
    const spend: CategorySpend = {
      currency: CurrencyCode.enum.BRL,
      categoryId: 'cat-food',
      subCategoryId: null,
      effective: 200,
      pending: 0,
    };
    let calledWith: [string, string] | undefined;
    const deps = makeDeps({
      budgets: { list: async () => [row] } as unknown as Deps['budgets'],
      transactions: {
        spendByCategory: async (from: string, to: string) => {
          calledWith = [from, to];
          return [spend];
        },
      } as unknown as Deps['transactions'],
    });

    const result = await getBudgetStatus(deps, { month: 7, year: 2026 });

    expect(calledWith).toEqual(['2026-07-01', '2026-08-01']);
    expect(result).toEqual({
      period: { month: 7, year: 2026 },
      categories: [
        {
          category: 'Food',
          lines: [
            {
              id: 'budget-1',
              currency: CurrencyCode.enum.BRL,
              limit: 500,
              period: BudgetPeriod.enum.monthly,
              subCategory: undefined,
              effective: { amount: 200, pct: 0.4 },
              committed: { amount: 200, pct: 0.4 },
              pending: { amount: 0, pct: 0 },
              remaining: 300,
            },
          ],
        },
      ],
    });
  });

  it("localizes the category name via the row's names JSON for the resolved locale", async () => {
    const row = budgetViewRow({ nodeNames: { pt: 'Comida' } });
    const deps = makeDeps({
      budgets: { list: async () => [row] } as unknown as Deps['budgets'],
      transactions: { spendByCategory: async () => [] } as unknown as Deps['transactions'],
      locale: async () => Locale.enum.pt,
    });
    const result = await getBudgetStatus(deps, { month: 7, year: 2026 });
    expect(result.categories[0]?.category).toBe('Comida');
  });

  it('returns an empty categories array when there are no budgets', async () => {
    const deps = makeDeps({
      budgets: { list: async () => [] } as unknown as Deps['budgets'],
      transactions: { spendByCategory: async () => [] } as unknown as Deps['transactions'],
    });
    const result = await getBudgetStatus(deps, { month: 1, year: 2026 });
    expect(result).toEqual({ period: { month: 1, year: 2026 }, categories: [] });
  });
});

describe('getBudgetStatus — displayCurrency', () => {
  const { BRL, USD, BTC } = CurrencyCode.enum;
  const NOW = new Date('2026-08-10T12:00:00.000Z');
  const PERIOD = { month: 7, year: 2026 };

  const CURRENCIES: Currency[] = [
    { code: BRL, symbol: 'R$', name: 'Real', decimals: 2 },
    { code: USD, symbol: '$', name: 'Dollar', decimals: 2 },
    { code: BTC, symbol: '₿', name: 'Bitcoin', decimals: 8 },
  ];

  const rate = (overrides: Partial<CurrencyRateEntity> = {}): CurrencyRateEntity => ({
    id: 'rate-1',
    fromCode: BRL,
    toCode: USD,
    rate: 0.2,
    asOf: NOW.toISOString(),
    source: null,
    version: 0,
    ...overrides,
  });

  const withRatesDeps = (overrides: Partial<Deps> = {}): Deps =>
    makeDeps({
      currencies: { list: async () => CURRENCIES } as unknown as Deps['currencies'],
      currencyRates: { list: async () => [] } as unknown as Deps['currencyRates'],
      clock: () => NOW,
      ...overrides,
    });

  it('omitting displayCurrency returns a response with no converted block (regression pin)', async () => {
    const row = budgetViewRow({ currency: USD });
    const spend: CategorySpend = {
      currency: USD,
      categoryId: 'cat-food',
      subCategoryId: null,
      effective: 50,
      pending: 0,
    };
    const deps = withRatesDeps({
      budgets: { list: async () => [row] } as unknown as Deps['budgets'],
      transactions: { spendByCategory: async () => [spend] } as unknown as Deps['transactions'],
    });

    const result = await getBudgetStatus(deps, PERIOD);

    expect(result).not.toHaveProperty('converted');
  });

  it('displayCurrency provided: converts and sums committed spend across budgeted categories', async () => {
    const usdRow = budgetViewRow({ id: 'budget-usd', currency: USD, targetId: 'cat-food' });
    const brlRow = budgetViewRow({
      id: 'budget-brl',
      currency: BRL,
      targetId: 'cat-transport',
      nodeName: 'Transport',
    });
    const spend: CategorySpend[] = [
      { currency: USD, categoryId: 'cat-food', subCategoryId: null, effective: 80, pending: 20 },
      { currency: BRL, categoryId: 'cat-transport', subCategoryId: null, effective: 500, pending: 0 },
    ];
    const deps = withRatesDeps({
      budgets: { list: async () => [usdRow, brlRow] } as unknown as Deps['budgets'],
      transactions: { spendByCategory: async () => spend } as unknown as Deps['transactions'],
      currencyRates: {
        list: async () => [rate({ fromCode: BRL, toCode: USD, rate: 0.2 })],
      } as unknown as Deps['currencyRates'],
    });

    const result = await getBudgetStatus(deps, PERIOD, USD);

    // USD committed 80+20=100 identity + BRL committed 500 * 0.2 = 100 -> 200
    expect(result.converted).toEqual({
      displayCurrency: USD,
      total: 200,
      stale: false,
      asOf: NOW.toISOString(),
      excluded: [],
    });
  });

  it('does not double-count a spend row matched by both a sub-category and its rolled-up parent budget', async () => {
    const parentRow = budgetViewRow({ id: 'budget-food', currency: USD, targetId: 'cat-food' });
    const subRow = budgetViewRow({
      id: 'budget-restaurants',
      currency: USD,
      targetId: 'sub-restaurants',
      nodeName: 'Restaurants',
      nodeParentId: 'cat-food',
      parentName: 'Food',
    });
    const spend: CategorySpend[] = [
      { currency: USD, categoryId: 'cat-food', subCategoryId: 'sub-restaurants', effective: 100, pending: 0 },
    ];
    const deps = withRatesDeps({
      budgets: { list: async () => [parentRow, subRow] } as unknown as Deps['budgets'],
      transactions: { spendByCategory: async () => spend } as unknown as Deps['transactions'],
    });

    const result = await getBudgetStatus(deps, PERIOD, USD);

    expect(result.converted).toMatchObject({ total: 100 });
  });

  it('displayCurrency provided leaves per-category lines unchanged', async () => {
    const row = budgetViewRow({ currency: USD });
    const spend: CategorySpend = {
      currency: USD,
      categoryId: 'cat-food',
      subCategoryId: null,
      effective: 50,
      pending: 0,
    };
    const deps = withRatesDeps({
      budgets: { list: async () => [row] } as unknown as Deps['budgets'],
      transactions: { spendByCategory: async () => [spend] } as unknown as Deps['transactions'],
    });

    const omitted = await getBudgetStatus(deps, PERIOD);
    const provided = await getBudgetStatus(deps, PERIOD, USD);

    expect(provided.categories).toEqual(omitted.categories);
  });

  it('a currency with no rate to displayCurrency is excluded from the total and listed', async () => {
    const row = budgetViewRow({ currency: BTC });
    const spend: CategorySpend = {
      currency: BTC,
      categoryId: 'cat-food',
      subCategoryId: null,
      effective: 1,
      pending: 0,
    };
    const deps = withRatesDeps({
      budgets: { list: async () => [row] } as unknown as Deps['budgets'],
      transactions: { spendByCategory: async () => [spend] } as unknown as Deps['transactions'],
    });

    const result = await getBudgetStatus(deps, PERIOD, USD);

    expect(result.converted).toEqual({
      displayCurrency: USD,
      total: 0,
      stale: false,
      asOf: null,
      excluded: [{ currency: BTC, reason: 'no_rate' }],
    });
  });

  it('rebuilds period from its declared fields — both diplomat callers pass their whole args object, ' +
    'which also carries displayCurrency', async () => {
    const deps = withRatesDeps({
      budgets: { list: async () => [] } as unknown as Deps['budgets'],
      transactions: { spendByCategory: async () => [] } as unknown as Deps['transactions'],
    });
    const periodWithExtraField = { ...PERIOD, displayCurrency: USD } as unknown as typeof PERIOD;

    const result = await getBudgetStatus(deps, periodWithExtraField, USD);

    expect(result.period).toEqual(PERIOD);
    expect(result.period).not.toHaveProperty('displayCurrency');
  });
});
