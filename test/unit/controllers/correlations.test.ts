import { describe, expect, it } from 'vitest';
import { findCorrelations } from '../../../src/controllers/correlations.js';
import type { Deps } from '../../../src/controllers/deps.js';
import { FindCorrelationsAnalysis, type ResolvedFindCorrelations } from '../../../src/models/correlations.js';
import { Locale } from '../../../src/models/locale.js';
import { CurrencyCode } from '../../../src/models/money.js';
import type { BudgetFitDbRow, SpendingShiftDbRow } from '../../../src/wire/db/correlations.js';

const makeDeps = (overrides: Partial<Deps> = {}): Deps => ({
  accounts: {} as Deps['accounts'],
  bills: {} as Deps['bills'],
  budgets: {} as Deps['budgets'],
  categories: {} as Deps['categories'],
  subCategories: {} as Deps['subCategories'],
  correlations: {
    spendingShifts: async () => [],
    budgetFit: async () => [],
  } as unknown as Deps['correlations'],
  creditCards: {} as Deps['creditCards'],
  dashboards: {} as Deps['dashboards'],
  health: {} as Deps['health'],
  merchants: {} as Deps['merchants'],
  recurring: {} as Deps['recurring'],
  settings: {} as Deps['settings'],
  tags: {} as Deps['tags'],
  transactions: {} as Deps['transactions'],
  clock: () => new Date('2026-07-15'),
  newId: () => 'id-1',
  locale: async () => Locale.enum.en,
  ...overrides,
});

const input = (overrides: Partial<ResolvedFindCorrelations> = {}): ResolvedFindCorrelations => ({
  analysis: FindCorrelationsAnalysis.enum.spending_shifts,
  month: 7,
  year: 2026,
  baselineMonths: 3,
  minDeltaPct: 20,
  slackPct: 20,
  overPct: 20,
  ...overrides,
});

describe('findCorrelations — spending_shifts', () => {
  it('derives the current/baseline windows from month+year+baselineMonths and shapes the repo rows', async () => {
    let calledWith: [string, string, string] | undefined;
    const row: SpendingShiftDbRow = {
      category: 'Food',
      categoryNames: null,
      currency: CurrencyCode.enum.BRL,
      current: 1200,
      baselineTotal: 900,
    };
    const deps = makeDeps({
      correlations: {
        spendingShifts: async (baselineFrom: string, currentFrom: string, currentTo: string) => {
          calledWith = [baselineFrom, currentFrom, currentTo];
          return [row];
        },
      } as unknown as Deps['correlations'],
    });

    const result = await findCorrelations(deps, input());

    expect(calledWith).toEqual(['2026-04-01', '2026-07-01', '2026-08-01']);
    expect(result).toEqual({
      analysis: 'spending_shifts',
      month: 7,
      year: 2026,
      shifts: [{ category: 'Food', currency: 'BRL', current: 1200, baseline: 300, deltaPct: 300, direction: 'up' }],
    });
  });

  it('returns an empty shifts array for an empty reference month', async () => {
    const deps = makeDeps();
    const result = await findCorrelations(deps, input());
    expect(result).toEqual({ analysis: 'spending_shifts', month: 7, year: 2026, shifts: [] });
  });

  it('resolves locale once and localizes category names through it', async () => {
    const deps = makeDeps({
      locale: async () => Locale.enum.pt,
      correlations: {
        spendingShifts: async () => [
          {
            category: 'Food',
            categoryNames: { pt: 'Alimentação' },
            currency: CurrencyCode.enum.BRL,
            current: 500,
            baselineTotal: 0,
          } satisfies SpendingShiftDbRow,
        ],
      } as unknown as Deps['correlations'],
    });

    const result = await findCorrelations(deps, input());
    expect(result).toMatchObject({
      analysis: 'spending_shifts',
      shifts: [{ category: 'Alimentação', deltaPct: null, direction: 'up' }],
    });
  });

  it('fails loudly instead of returning undefined for an analysis the switch does not handle', async () => {
    // Can't happen through the MCP boundary (zod restricts `analysis`) — exercises assertNeverAnalysis directly.
    const deps = makeDeps();
    const bogusInput = { ...input(), analysis: 'not_a_real_analysis' } as unknown as ResolvedFindCorrelations;
    await expect(findCorrelations(deps, bogusInput)).rejects.toThrow(/unhandled analysis/);
  });
});

const budgetFitInput = (overrides: Partial<ResolvedFindCorrelations> = {}): ResolvedFindCorrelations =>
  input({ analysis: FindCorrelationsAnalysis.enum.budget_fit, ...overrides });

const budgetRow = (overrides: Partial<BudgetFitDbRow> = {}): BudgetFitDbRow => ({
  id: 'budget-1',
  currency: CurrencyCode.enum.BRL,
  node_name: 'Food',
  node_parent_id: null,
  parent_name: null,
  nodeNames: null,
  parentNames: null,
  current: 0,
  limit: 300,
  baselineTotal: 900,
  ...overrides,
});

describe('findCorrelations — budget_fit', () => {
  it('derives the same current/baseline windows as spending_shifts and calls both repo methods', async () => {
    let budgetFitCalledWith: [string, string, string] | undefined;
    let shiftsCalledWith: [string, string, string] | undefined;
    const deps = makeDeps({
      correlations: {
        budgetFit: async (baselineFrom: string, currentFrom: string, currentTo: string) => {
          budgetFitCalledWith = [baselineFrom, currentFrom, currentTo];
          return [];
        },
        spendingShifts: async (baselineFrom: string, currentFrom: string, currentTo: string) => {
          shiftsCalledWith = [baselineFrom, currentFrom, currentTo];
          return [];
        },
      } as unknown as Deps['correlations'],
    });

    const result = await findCorrelations(deps, budgetFitInput());

    expect(budgetFitCalledWith).toEqual(['2026-04-01', '2026-07-01', '2026-08-01']);
    expect(shiftsCalledWith).toEqual(['2026-04-01', '2026-07-01', '2026-08-01']);
    expect(result).toEqual({ analysis: 'budget_fit', month: 7, year: 2026, budgeted: [], unbudgeted: [] });
  });

  it('reports unrealistic + a suggestedLimit near baseline for a materially over-budget category', async () => {
    const deps = makeDeps({
      correlations: {
        budgetFit: async () => [budgetRow({ limit: 200, baselineTotal: 900 })], // baseline 300, ratio 1.5
        spendingShifts: async () => [],
      } as unknown as Deps['correlations'],
    });

    const result = await findCorrelations(deps, budgetFitInput());
    expect(result).toMatchObject({
      budgeted: [{ category: 'Food', limit: 200, baseline: 300, verdict: 'unrealistic', suggestedLimit: 330 }],
    });
  });

  it('reports generous for a category well under its limit', async () => {
    const deps = makeDeps({
      correlations: {
        budgetFit: async () => [budgetRow({ limit: 1000, baselineTotal: 900 })], // baseline 300, ratio 0.3
        spendingShifts: async () => [],
      } as unknown as Deps['correlations'],
    });

    const result = await findCorrelations(deps, budgetFitInput());
    expect(result).toMatchObject({ budgeted: [{ verdict: 'generous' }] });
  });

  it('reports realistic when baseline is within tolerance of the limit', async () => {
    const deps = makeDeps({
      correlations: {
        budgetFit: async () => [budgetRow({ limit: 300, baselineTotal: 900 })], // baseline 300, ratio 1.0
        spendingShifts: async () => [],
      } as unknown as Deps['correlations'],
    });

    const result = await findCorrelations(deps, budgetFitInput());
    expect(result).toMatchObject({ budgeted: [{ verdict: 'realistic' }] });
  });

  it('handles a budget with no spend at all (current: 0, baseline: 0) without error', async () => {
    const deps = makeDeps({
      correlations: {
        budgetFit: async () => [budgetRow({ limit: 300, baselineTotal: 0, current: 0 })],
        spendingShifts: async () => [],
      } as unknown as Deps['correlations'],
    });

    const result = await findCorrelations(deps, budgetFitInput());
    expect(result).toMatchObject({ budgeted: [{ current: 0, baseline: 0, verdict: 'generous' }] });
  });

  it('reports a sub-category budget under its parent category name', async () => {
    const deps = makeDeps({
      correlations: {
        budgetFit: async () => [
          budgetRow({
            node_name: 'Restaurants',
            node_parent_id: 'cat-food',
            parent_name: 'Food',
            limit: 300,
            baselineTotal: 900,
          }),
        ],
        spendingShifts: async () => [],
      } as unknown as Deps['correlations'],
    });

    const result = await findCorrelations(deps, budgetFitInput());
    expect(result).toMatchObject({ budgeted: [{ category: 'Food', subCategory: 'Restaurants' }] });
  });

  it('surfaces a category with an established baseline and no budget as unbudgeted', async () => {
    const deps = makeDeps({
      correlations: {
        budgetFit: async () => [],
        spendingShifts: async () => [
          {
            category: 'Transport',
            categoryNames: null,
            currency: CurrencyCode.enum.BRL,
            current: 100,
            baselineTotal: 900,
          } satisfies SpendingShiftDbRow,
        ],
      } as unknown as Deps['correlations'],
    });

    const result = await findCorrelations(deps, budgetFitInput());
    expect(result).toMatchObject({
      unbudgeted: [{ category: 'Transport', currency: 'BRL', baseline: 300, suggestedLimit: 330 }],
    });
  });

  it('excludes a category already covered by a budget from unbudgeted', async () => {
    const deps = makeDeps({
      correlations: {
        budgetFit: async () => [budgetRow({ limit: 300, baselineTotal: 900 })], // category "Food"
        spendingShifts: async () => [
          {
            category: 'Food',
            categoryNames: null,
            currency: CurrencyCode.enum.BRL,
            current: 300,
            baselineTotal: 900,
          } satisfies SpendingShiftDbRow,
        ],
      } as unknown as Deps['correlations'],
    });

    const result = await findCorrelations(deps, budgetFitInput());
    expect(result).toMatchObject({ analysis: 'budget_fit', unbudgeted: [] });
  });

  it('excludes a brand-new (zero-baseline) category from unbudgeted — no established pattern yet', async () => {
    const deps = makeDeps({
      correlations: {
        budgetFit: async () => [],
        spendingShifts: async () => [
          {
            category: 'Brand New',
            categoryNames: null,
            currency: CurrencyCode.enum.BRL,
            current: 500,
            baselineTotal: 0,
          } satisfies SpendingShiftDbRow,
        ],
      } as unknown as Deps['correlations'],
    });

    const result = await findCorrelations(deps, budgetFitInput());
    expect(result).toMatchObject({ analysis: 'budget_fit', unbudgeted: [] });
  });
});
