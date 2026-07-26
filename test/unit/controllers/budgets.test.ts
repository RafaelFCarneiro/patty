import { describe, expect, it } from 'vitest';
import { createBudget, deleteBudget, listBudgets, updateBudget } from '../../../src/controllers/budgets.js';
import type { Deps } from '../../../src/controllers/deps.js';
import { BUDGET_ENTITY_TAG, BudgetPeriod, type BudgetEntity, type BudgetView } from '../../../src/models/budget.js';
import type { Category, SubCategory } from '../../../src/models/category.js';
import { CategoryKind } from '../../../src/models/category.js';
import { Locale } from '../../../src/models/locale.js';
import { CurrencyCode } from '../../../src/models/money.js';
import { PersistOp } from '../../../src/models/persistable.js';

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
  creditCards: {} as Deps['creditCards'],
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

describe('listBudgets', () => {
  it('delegates to the repo', async () => {
    const view: BudgetView = {
      id: 'budget-1',
      category: 'Food',
      currency: CurrencyCode.enum.BRL,
      limit: 500,
      period: BudgetPeriod.enum.monthly,
    };
    const deps = makeDeps({ budgets: { list: async () => [view] } as unknown as Deps['budgets'] });
    expect(await listBudgets(deps)).toEqual([view]);
  });
});
