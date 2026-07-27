import { describe, expect, it } from 'vitest';
import { findCorrelations } from '../../../src/controllers/correlations.js';
import type { Deps } from '../../../src/controllers/deps.js';
import { FindCorrelationsAnalysis, type ResolvedFindCorrelations } from '../../../src/models/correlations.js';
import { Locale } from '../../../src/models/locale.js';
import { CurrencyCode } from '../../../src/models/money.js';
import type { SpendingShiftDbRow } from '../../../src/wire/db/correlations.js';

const makeDeps = (overrides: Partial<Deps> = {}): Deps => ({
  accounts: {} as Deps['accounts'],
  bills: {} as Deps['bills'],
  budgets: {} as Deps['budgets'],
  categories: {} as Deps['categories'],
  subCategories: {} as Deps['subCategories'],
  correlations: { spendingShifts: async () => [] } as unknown as Deps['correlations'],
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
    expect(result.shifts[0]).toMatchObject({ category: 'Alimentação', deltaPct: null, direction: 'up' });
  });

  it('fails loudly instead of returning undefined for an analysis the switch does not handle', async () => {
    // Can't happen through the MCP boundary (zod restricts `analysis` to the whitelisted enum) —
    // exercises the runtime `assertNeverAnalysis` guard directly, the twin of the compile-time
    // exhaustiveness check (a case is TS2366-enforced for every real `FindCorrelationsAnalysis` member).
    const deps = makeDeps();
    const bogusInput = { ...input(), analysis: 'not_a_real_analysis' } as unknown as ResolvedFindCorrelations;
    await expect(findCorrelations(deps, bogusInput)).rejects.toThrow(/unhandled analysis/);
  });
});
