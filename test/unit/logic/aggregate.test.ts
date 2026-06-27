import { describe, expect, it } from 'vitest'
import { shapeAggregateResult } from '../../../src/logic/aggregate.js'
import { AggregateGroupBy, AggregateSort } from '../../../src/models/aggregate.js'
import type { AggregateDbRow } from '../../../src/wire/db/aggregate.js'

const row = (overrides: Partial<AggregateDbRow> = {}): AggregateDbRow => ({
  key: 'cat-food',
  label: 'Food',
  labelNames: null,
  currency: 'BRL',
  value: 100,
  count: 5,
  ...overrides,
})

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
    )
    expect(out).toHaveLength(2)
    const brl = out.find((b) => b.currency === 'BRL')!
    expect(brl.total).toBe(1000)
    expect(brl.rows[0]!.pct).toBe(60)
    expect(brl.rows[1]!.pct).toBe(40)
    const usd = out.find((b) => b.currency === 'USD')!
    expect(usd.total).toBe(50)
    expect(usd.rows[0]!.pct).toBe(100)
  })

  it('sorts asc when requested', () => {
    const out = shapeAggregateResult(
      [
        row({ key: 'a', value: 300 }),
        row({ key: 'b', value: 100 }),
      ],
      AggregateGroupBy.enum.category,
      AggregateSort.enum.asc,
      'en',
    )
    expect(out[0]!.rows.map((r) => r.key)).toEqual(['b', 'a'])
  })

  it('sorts desc by default', () => {
    const out = shapeAggregateResult(
      [
        row({ key: 'a', value: 100 }),
        row({ key: 'b', value: 300 }),
      ],
      AggregateGroupBy.enum.category,
      AggregateSort.enum.desc,
      'en',
    )
    expect(out[0]!.rows.map((r) => r.key)).toEqual(['b', 'a'])
  })

  it('handles empty input', () => {
    const out = shapeAggregateResult([], AggregateGroupBy.enum.category, AggregateSort.enum.desc, 'en')
    expect(out).toEqual([])
  })

  it('handles single row', () => {
    const out = shapeAggregateResult(
      [row({ value: 42, count: 1 })],
      AggregateGroupBy.enum.account,
      AggregateSort.enum.desc,
      'en',
    )
    expect(out).toHaveLength(1)
    expect(out[0]!.total).toBe(42)
    expect(out[0]!.rows[0]!.pct).toBe(100)
  })

  it('zero-total guard: pct is 0 when total is 0', () => {
    const out = shapeAggregateResult(
      [row({ value: 0, count: 3 })],
      AggregateGroupBy.enum.category,
      AggregateSort.enum.desc,
      'en',
    )
    expect(out[0]!.total).toBe(0)
    expect(out[0]!.rows[0]!.pct).toBe(0)
  })

  it('resolves category label from names JSON via locale', () => {
    const out = shapeAggregateResult(
      [row({ key: 'cat-food', label: 'Food', labelNames: { pt: 'Alimentação', es: 'Alimentación' } })],
      AggregateGroupBy.enum.category,
      AggregateSort.enum.desc,
      'pt',
    )
    expect(out[0]!.rows[0]!.label).toBe('Alimentação')
  })

  it('falls back to canonical name when locale translation missing', () => {
    const out = shapeAggregateResult(
      [row({ key: 'cat-food', label: 'Food', labelNames: { pt: 'Alimentação' } })],
      AggregateGroupBy.enum.category,
      AggregateSort.enum.desc,
      'es',
    )
    expect(out[0]!.rows[0]!.label).toBe('Food')
  })

  it('non-category groupBy uses label directly', () => {
    const out = shapeAggregateResult(
      [row({ key: 'acc-1', label: 'Nubank' })],
      AggregateGroupBy.enum.account,
      AggregateSort.enum.desc,
      'en',
    )
    expect(out[0]!.rows[0]!.label).toBe('Nubank')
  })

  it('falls back to key when label is null', () => {
    const out = shapeAggregateResult(
      [row({ key: 'some-merchant', label: null })],
      AggregateGroupBy.enum.merchant,
      AggregateSort.enum.desc,
      'en',
    )
    expect(out[0]!.rows[0]!.label).toBe('some-merchant')
  })
})
