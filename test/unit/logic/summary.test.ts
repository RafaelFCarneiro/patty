import { describe, expect, it } from 'vitest';
import { summarize } from '../../../src/logic/summary.js';
import type { DecimalsFor } from '../../../src/logic/money.js';

// Fiat-shaped 2 decimals for every currency, matching existing behavior before ADR-026 — tests
// that care about a different currency's own decimals pass their own lookup explicitly.
const decimalsFor: DecimalsFor = () => 2;

const row = (overrides: Partial<Parameters<typeof summarize>[0][number]>) => ({
  currency: 'BRL' as const,
  type: 'expense' as const,
  category: null,
  categoryNames: null,
  total: 0,
  count: 1,
  ...overrides,
});

describe('summarize', () => {
  it('groups strictly per currency — never mixes', () => {
    const out = summarize(
      [
        row({ currency: 'BRL', type: 'expense', category: 'Transporte', total: 100, count: 4 }),
        row({ currency: 'BRL', type: 'income', category: 'Salário', total: 5000, count: 1 }),
        row({ currency: 'USD', type: 'expense', category: 'Assinaturas', total: 20, count: 2 }),
      ],
      'en',
      decimalsFor,
    );
    expect(out).toHaveLength(2);
    const brl = out.find((s) => s.currency === 'BRL')!;
    expect(brl.balance).toBe(4900);
    const usd = out.find((s) => s.currency === 'USD')!;
    expect(usd).toMatchObject({ income: 0, expenses: 20, balance: -20 });
  });

  it('labels null category with locale-aware fallback and sorts by total desc', () => {
    const out = summarize(
      [row({ category: null, total: 10 }), row({ category: 'Lazer', total: 200, count: 2 })],
      'pt',
      decimalsFor,
    );
    expect(out[0]!.byCategory.map((c) => c.category)).toEqual(['Lazer', 'Sem categoria']);
  });

  it('uncategorized label follows locale — en', () => {
    const out = summarize([row({ category: null, total: 10 })], 'en', decimalsFor);
    expect(out[0]!.byCategory[0]!.category).toBe('Uncategorized');
  });

  it('uncategorized label follows locale — es', () => {
    const out = summarize([row({ category: null, total: 10 })], 'es', decimalsFor);
    expect(out[0]!.byCategory[0]!.category).toBe('Sin categoría');
  });

  it('localizes category name from names JSON', () => {
    const out = summarize(
      [row({ category: 'Food', categoryNames: { pt: 'Alimentação', es: 'Alimentación' }, total: 50 })],
      'pt',
      decimalsFor,
    );
    expect(out[0]!.byCategory[0]!.category).toBe('Alimentação');
  });

  it('falls back to canonical name when translation is missing', () => {
    const out = summarize(
      [row({ category: 'Food', categoryNames: { pt: 'Alimentação' }, total: 50 })],
      'es',
      decimalsFor,
    );
    expect(out[0]!.byCategory[0]!.category).toBe('Food');
  });

  it('user-created category (names=null) shows literal name', () => {
    const out = summarize([row({ category: 'My Custom', categoryNames: null, total: 30 })], 'pt', decimalsFor);
    expect(out[0]!.byCategory[0]!.category).toBe('My Custom');
  });

  it('rounds monetary totals to 2 decimal places', () => {
    const out = summarize(
      [
        row({ type: 'income', category: 'Renda Extra', total: 0.1 }),
        row({ type: 'income', category: 'Renda Extra', total: 0.2 }),
        row({ type: 'expense', category: 'Transporte', total: 0.05 }),
      ],
      'en',
      decimalsFor,
    );

    expect(out).toHaveLength(1);
    expect(out[0]!.income).toBe(0.3);
    expect(out[0]!.expenses).toBe(0.05);
    expect(out[0]!.balance).toBe(0.25);
  });

  it('per-currency totals are unchanged by locale', () => {
    const rows = [
      row({
        currency: 'BRL',
        type: 'expense',
        category: 'Food',
        categoryNames: { pt: 'Alimentação' },
        total: 100,
        count: 3,
      }),
      row({
        currency: 'BRL',
        type: 'income',
        category: 'Salary',
        categoryNames: { pt: 'Salário' },
        total: 5000,
        count: 1,
      }),
    ];
    const en = summarize(rows, 'en', decimalsFor);
    const pt = summarize(rows, 'pt', decimalsFor);
    expect(en[0]!.income).toBe(pt[0]!.income);
    expect(en[0]!.expenses).toBe(pt[0]!.expenses);
    expect(en[0]!.balance).toBe(pt[0]!.balance);
  });

  it("rounds a currency's total to its own decimals (ADR-026) — a flat 2 would corrupt BTC", () => {
    const btcDecimalsFor: DecimalsFor = (code) => (code === 'BTC' ? 8 : 2);
    const out = summarize(
      [row({ currency: 'BTC', type: 'income', category: 'Mining', total: 0.123456785 })],
      'en',
      btcDecimalsFor,
    );
    expect(out[0]!.income).toBe(0.12345679); // rounded to 8 decimals, not flattened to 0.12
  });
});
