import { describe, expect, it } from 'vitest';
import { shapeAggregateResult, wantsDisplayConversion } from '../../../src/logic/aggregate.js';
import type { DecimalsFor } from '../../../src/models/money.js';
import { AggregateGroupBy, AggregateMetric, AggregateSort } from '../../../src/models/aggregate.js';
import type { AggregateDbRow } from '../../../src/wire/db/aggregate.js';

// Fiat-shaped 2 decimals for every currency, matching existing behavior before ADR-026 — the
// dedicated decimals test below passes its own lookup.
const decimalsFor: DecimalsFor = () => 2;

const row = (overrides: Partial<AggregateDbRow> = {}): AggregateDbRow => ({
  key: 'cat-food',
  label: 'Food',
  labelNames: null,
  currency: 'BRL',
  value: 100,
  count: 5,
  ...overrides,
});

describe('shapeAggregateResult', () => {
  it('groups per currency and computes total + pct', () => {
    const out = shapeAggregateResult(
      [
        row({ key: 'cat-food', label: 'Food', currency: 'BRL', value: 600, count: 10 }),
        row({ key: 'cat-transport', label: 'Transport', currency: 'BRL', value: 400, count: 5 }),
        row({ key: 'cat-food', label: 'Food', currency: 'USD', value: 50, count: 2 }),
      ],
      AggregateGroupBy.enum.category,
      AggregateSort.enum.desc,
      'en',
      decimalsFor,
    );
    expect(out).toHaveLength(2);
    const brl = out.find((b) => b.currency === 'BRL')!;
    expect(brl.total).toBe(1000);
    expect(brl.rows[0]!.pct).toBe(60);
    expect(brl.rows[1]!.pct).toBe(40);
    const usd = out.find((b) => b.currency === 'USD')!;
    expect(usd.total).toBe(50);
    expect(usd.rows[0]!.pct).toBe(100);
  });

  it('sorts asc when requested', () => {
    const out = shapeAggregateResult(
      [row({ key: 'a', value: 300 }), row({ key: 'b', value: 100 })],
      AggregateGroupBy.enum.category,
      AggregateSort.enum.asc,
      'en',
      decimalsFor,
    );
    expect(out[0]!.rows.map((r) => r.key)).toEqual(['b', 'a']);
  });

  it('sorts desc by default', () => {
    const out = shapeAggregateResult(
      [row({ key: 'a', value: 100 }), row({ key: 'b', value: 300 })],
      AggregateGroupBy.enum.category,
      AggregateSort.enum.desc,
      'en',
      decimalsFor,
    );
    expect(out[0]!.rows.map((r) => r.key)).toEqual(['b', 'a']);
  });

  it('handles empty input', () => {
    const out = shapeAggregateResult([], AggregateGroupBy.enum.category, AggregateSort.enum.desc, 'en', decimalsFor);
    expect(out).toEqual([]);
  });

  it('handles single row', () => {
    const out = shapeAggregateResult(
      [row({ value: 42, count: 1 })],
      AggregateGroupBy.enum.account,
      AggregateSort.enum.desc,
      'en',
      decimalsFor,
    );
    expect(out).toHaveLength(1);
    expect(out[0]!.total).toBe(42);
    expect(out[0]!.rows[0]!.pct).toBe(100);
  });

  it('zero-total guard: pct is 0 when total is 0', () => {
    const out = shapeAggregateResult(
      [row({ value: 0, count: 3 })],
      AggregateGroupBy.enum.category,
      AggregateSort.enum.desc,
      'en',
      decimalsFor,
    );
    expect(out[0]!.total).toBe(0);
    expect(out[0]!.rows[0]!.pct).toBe(0);
  });

  it('resolves category label from names JSON via locale', () => {
    const out = shapeAggregateResult(
      [row({ key: 'cat-food', label: 'Food', labelNames: { pt: 'Alimentação', es: 'Alimentación' } })],
      AggregateGroupBy.enum.category,
      AggregateSort.enum.desc,
      'pt',
      decimalsFor,
    );
    expect(out[0]!.rows[0]!.label).toBe('Alimentação');
  });

  it('falls back to canonical name when locale translation missing', () => {
    const out = shapeAggregateResult(
      [row({ key: 'cat-food', label: 'Food', labelNames: { pt: 'Alimentação' } })],
      AggregateGroupBy.enum.category,
      AggregateSort.enum.desc,
      'es',
      decimalsFor,
    );
    expect(out[0]!.rows[0]!.label).toBe('Food');
  });

  it('non-category groupBy uses label directly', () => {
    const out = shapeAggregateResult(
      [row({ key: 'acc-1', label: 'Nubank' })],
      AggregateGroupBy.enum.account,
      AggregateSort.enum.desc,
      'en',
      decimalsFor,
    );
    expect(out[0]!.rows[0]!.label).toBe('Nubank');
  });

  it('falls back to key when label is null', () => {
    const out = shapeAggregateResult(
      [row({ key: 'some-merchant', label: null })],
      AggregateGroupBy.enum.merchant,
      AggregateSort.enum.desc,
      'en',
      decimalsFor,
    );
    expect(out[0]!.rows[0]!.label).toBe('some-merchant');
  });

  it('handles null key (uncategorized) with locale-aware label for category groupBy', () => {
    const out = shapeAggregateResult(
      [row({ key: null, label: null, value: 50 })],
      AggregateGroupBy.enum.category,
      AggregateSort.enum.desc,
      'pt',
      decimalsFor,
    );
    expect(out[0]!.rows[0]!.key).toBe('uncategorized');
    expect(out[0]!.rows[0]!.label).toBe('Sem categoria');
  });

  it('handles null key with "unknown" label for non-category groupBy', () => {
    const out = shapeAggregateResult(
      [row({ key: null, label: null, value: 50 })],
      AggregateGroupBy.enum.merchant,
      AggregateSort.enum.desc,
      'en',
      decimalsFor,
    );
    expect(out[0]!.rows[0]!.key).toBe('unknown');
    expect(out[0]!.rows[0]!.label).toBe('Unknown');
  });

  it('applies limit per currency, not globally', () => {
    const out = shapeAggregateResult(
      [
        row({ key: 'a', value: 300, currency: 'BRL' }),
        row({ key: 'b', value: 200, currency: 'BRL' }),
        row({ key: 'c', value: 100, currency: 'BRL' }),
        row({ key: 'x', value: 50, currency: 'USD' }),
        row({ key: 'y', value: 25, currency: 'USD' }),
      ],
      AggregateGroupBy.enum.category,
      AggregateSort.enum.desc,
      'en',
      decimalsFor,
      2,
    );
    expect(out).toHaveLength(2);
    expect(out.find((b) => b.currency === 'BRL')!.rows).toHaveLength(2);
    expect(out.find((b) => b.currency === 'USD')!.rows).toHaveLength(2);
  });

  it("rounds a currency's total/values to its own decimals (ADR-026) — a flat 2 would corrupt BTC", () => {
    const btcDecimalsFor: DecimalsFor = (code) => (code === 'BTC' ? 8 : 2);
    const out = shapeAggregateResult(
      [row({ key: 'mining', label: 'Mining', currency: 'BTC', value: 0.123456785 })],
      AggregateGroupBy.enum.category,
      AggregateSort.enum.desc,
      'en',
      btcDecimalsFor,
    );
    expect(out[0]!.total).toBe(0.12345679); // rounded to 8 decimals, not flattened to 0.12
    expect(out[0]!.rows[0]!.value).toBe(0.12345679);
  });
});

describe('wantsDisplayConversion', () => {
  it('converts only a sum with a display currency', () => {
    expect(wantsDisplayConversion({ metric: AggregateMetric.enum.sum, displayCurrency: 'USD' })).toBe(true);
  });

  it('a sum without a display currency stays as is', () => {
    expect(wantsDisplayConversion({ metric: AggregateMetric.enum.sum })).toBe(false);
  });

  it.each([AggregateMetric.enum.count, AggregateMetric.enum.avg])(
    '%s is never converted — it is not a cross-currency amount',
    (metric) => {
      expect(wantsDisplayConversion({ metric, displayCurrency: 'USD' })).toBe(false);
    },
  );
});
