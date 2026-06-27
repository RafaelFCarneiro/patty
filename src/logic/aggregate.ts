import * as R from 'remeda'
import { localizeCategoryName } from './category.js'
import { AggregateGroupBy, AggregateSort, type AggregateRow, type CurrencyBlock } from '../models/aggregate.js'
import type { CurrencyCode } from '../models/money.js'
import type { Locale } from '../models/locale.js'
import type { AggregateDbRow } from '../wire/db/aggregate.js'

const roundMoney = (value: number): number => Math.round((value + Number.EPSILON) * 100) / 100

const UNCATEGORIZED_KEY = 'uncategorized'
const uncategorizedLabels: Record<Locale, string> = {
  en: 'Uncategorized',
  pt: 'Sem categoria',
  es: 'Sin categoría',
}

const resolveKey = (row: AggregateDbRow, groupBy: AggregateGroupBy): string => {
  if (row.key != null) return row.key
  if (groupBy === AggregateGroupBy.enum.category) return UNCATEGORIZED_KEY
  return UNCATEGORIZED_KEY
}

const resolveLabel = (row: AggregateDbRow, groupBy: AggregateGroupBy, locale: Locale): string => {
  if (row.key == null && groupBy === AggregateGroupBy.enum.category) return uncategorizedLabels[locale]
  if (groupBy === AggregateGroupBy.enum.category) {
    return localizeCategoryName(row.label, row.labelNames, locale) ?? row.key!
  }
  return row.label ?? row.key ?? UNCATEGORIZED_KEY
}

const pct = (value: number, total: number): number =>
  total === 0 ? 0 : roundMoney((value / total) * 100)

export const shapeAggregateResult = (
  rows: readonly AggregateDbRow[],
  groupBy: AggregateGroupBy,
  sort: AggregateSort,
  locale: Locale,
): CurrencyBlock[] =>
  R.pipe(
    rows,
    R.groupBy((r) => r.currency),
    R.entries(),
    R.map(([currency, currencyRows]): CurrencyBlock => {
      const total = roundMoney(R.sumBy(currencyRows, (r) => r.value))
      const sorted = sort === AggregateSort.enum.asc
        ? R.sortBy(currencyRows, (r) => r.value)
        : R.sortBy(currencyRows, [(r) => r.value, 'desc'])
      const shapedRows: AggregateRow[] = sorted.map((r) => ({
        key: resolveKey(r, groupBy),
        label: resolveLabel(r, groupBy, locale),
        value: roundMoney(r.value),
        count: r.count,
        pct: pct(r.value, total),
      }))
      return { currency: currency as CurrencyCode, total, rows: shapedRows }
    }),
    R.sortBy((b) => b.currency),
  )
