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
