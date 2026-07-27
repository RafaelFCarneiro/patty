import { describe, expect, it } from 'vitest';
import { BUDGET_ENTITY_TAG, BudgetPeriod, type BudgetEntity } from '../../../src/models/budget.js';
import { CurrencyCode } from '../../../src/models/money.js';
import { INITIAL_VERSION, PersistOp, type Persistable } from '../../../src/models/persistable.js';
import type { BudgetRow } from '../../../src/wire/db/budgets.js';
import * as budgetAdapters from '../../../src/adapters/budgets.js';

const row: BudgetRow = {
  id: 'budget-1',
  categoryId: 'cat-food',
  currency: CurrencyCode.enum.BRL,
  limitAmount: 500,
  period: BudgetPeriod.enum.monthly,
  version: 3,
};

describe('dbToModel', () => {
  it('maps a db row to the Budget model, renaming limitAmount to limit', () => {
    expect(budgetAdapters.dbToModel(row)).toEqual({
      id: 'budget-1',
      categoryId: 'cat-food',
      currency: CurrencyCode.enum.BRL,
      limit: 500,
      period: BudgetPeriod.enum.monthly,
    });
  });
});

describe('dbToEntity', () => {
  it('carries version onto the read model (ADR-021)', () => {
    expect(budgetAdapters.dbToEntity(row)).toEqual({
      id: 'budget-1',
      categoryId: 'cat-food',
      currency: CurrencyCode.enum.BRL,
      limit: 500,
      period: BudgetPeriod.enum.monthly,
      version: 3,
    });
  });
});

describe('dbToView', () => {
  it('shows the top-level category when node_parent_id is null', () => {
    const view = budgetAdapters.dbToView({
      id: 'budget-1',
      currency: CurrencyCode.enum.BRL,
      limit_amount: 500,
      period: BudgetPeriod.enum.monthly,
      version: 3,
      node_name: 'Food',
      node_parent_id: null,
      parent_name: null,
    });
    expect(view).toEqual({
      id: 'budget-1',
      currency: CurrencyCode.enum.BRL,
      limit: 500,
      period: BudgetPeriod.enum.monthly,
      category: 'Food',
    });
  });

  it('shows category+subCategory when node_parent_id is set', () => {
    const view = budgetAdapters.dbToView({
      id: 'budget-1',
      currency: CurrencyCode.enum.BRL,
      limit_amount: 500,
      period: BudgetPeriod.enum.monthly,
      version: 3,
      node_name: 'Restaurants',
      node_parent_id: 'cat-food',
      parent_name: 'Food',
    });
    expect(view).toEqual({
      id: 'budget-1',
      currency: CurrencyCode.enum.BRL,
      limit: 500,
      period: BudgetPeriod.enum.monthly,
      category: 'Food',
      subCategory: 'Restaurants',
    });
  });
});

describe('dbToStatusEntry', () => {
  it('shows the top-level category and carries spend when node_parent_id is null', () => {
    const entry = budgetAdapters.dbToStatusEntry({
      id: 'budget-1',
      currency: CurrencyCode.enum.BRL,
      limit_amount: 500,
      period: BudgetPeriod.enum.monthly,
      node_name: 'Food',
      node_parent_id: null,
      parent_name: null,
      spent: 320,
    });
    expect(entry).toEqual({
      id: 'budget-1',
      currency: CurrencyCode.enum.BRL,
      limit: 500,
      period: BudgetPeriod.enum.monthly,
      category: 'Food',
      spent: 320,
    });
  });

  it('shows category+subCategory and carries spend when node_parent_id is set', () => {
    const entry = budgetAdapters.dbToStatusEntry({
      id: 'budget-2',
      currency: CurrencyCode.enum.BRL,
      limit_amount: 100,
      period: BudgetPeriod.enum.monthly,
      node_name: 'Restaurants',
      node_parent_id: 'cat-food',
      parent_name: 'Food',
      spent: 0,
    });
    expect(entry).toEqual({
      id: 'budget-2',
      currency: CurrencyCode.enum.BRL,
      limit: 100,
      period: BudgetPeriod.enum.monthly,
      category: 'Food',
      subCategory: 'Restaurants',
      spent: 0,
    });
  });
});

const entity: BudgetEntity = {
  id: 'budget-1',
  categoryId: 'cat-food',
  currency: CurrencyCode.enum.BRL,
  limit: 500,
  period: BudgetPeriod.enum.monthly,
  version: 3,
};

describe('modelToDb', () => {
  it('renames limit to limitAmount, passing the rest through', () => {
    expect(budgetAdapters.modelToDb(entity)).toEqual({
      id: 'budget-1',
      categoryId: 'cat-food',
      currency: CurrencyCode.enum.BRL,
      limitAmount: 500,
      period: BudgetPeriod.enum.monthly,
      version: 3,
    });
  });
});

describe('persistableToDb (budgets) — model→row adaptation lives at the diplomat edge', () => {
  it('insert: bakes in INITIAL_VERSION and renames limit to limitAmount', () => {
    const p: Persistable = {
      op: PersistOp.enum.insert,
      entity: BUDGET_ENTITY_TAG,
      model: {
        id: 'budget-1',
        categoryId: 'cat-food',
        currency: CurrencyCode.enum.BRL,
        limit: 500,
        period: BudgetPeriod.enum.monthly,
      },
    };
    expect(budgetAdapters.persistableToDb(p)).toEqual({
      op: PersistOp.enum.insert,
      entity: BUDGET_ENTITY_TAG,
      model: {
        id: 'budget-1',
        categoryId: 'cat-food',
        currency: CurrencyCode.enum.BRL,
        limitAmount: 500,
        period: BudgetPeriod.enum.monthly,
        version: INITIAL_VERSION,
      },
    });
  });

  it('delete: passes through unchanged — there is no model to adapt', () => {
    const p: Persistable = { op: PersistOp.enum.delete, entity: BUDGET_ENTITY_TAG, id: 'budget-1', version: 3 };
    expect(budgetAdapters.persistableToDb(p)).toEqual(p);
  });

  it('no-ops on a persistable tagged for a different entity', () => {
    const foreign: Persistable = { op: PersistOp.enum.insert, entity: 'account', model: { notABudget: true } };
    expect(budgetAdapters.persistableToDb(foreign)).toEqual(foreign);
  });
});
