import * as R from 'remeda';
import { localizeCategoryName } from './category.js';
import { roundMoney } from './money.js';
import { AggregateGroupBy, AggregateSort, type AggregateRow, type CurrencyBlock } from '../models/aggregate.js';
import type { CurrencyCode } from '../models/money.js';
import type { Locale } from '../models/locale.js';
import type { AggregateDbRow } from '../wire/db/aggregate.js';

const UNCATEGORIZED_KEY = 'uncategorized';
const uncategorizedLabels: Record<Locale, string> = {
  en: 'Uncategorized',
  pt: 'Sem categoria',
  es: 'Sin categoría',
};

const UNKNOWN_KEY = 'unknown';
const unknownLabels: Record<Locale, string> = {
  en: 'Unknown',
  pt: 'Desconhecido',
  es: 'Desconocido',
};

const resolveKey = (row: AggregateDbRow, groupBy: AggregateGroupBy): string => {
  if (R.isNonNullish(row.key)) return row.key;
  return groupBy === AggregateGroupBy.enum.category ? UNCATEGORIZED_KEY : UNKNOWN_KEY;
};

const resolveLabel = (row: AggregateDbRow, groupBy: AggregateGroupBy, locale: Locale): string => {
  if (!R.isNonNullish(row.key)) {
    return groupBy === AggregateGroupBy.enum.category ? uncategorizedLabels[locale] : unknownLabels[locale];
  }
  if (groupBy === AggregateGroupBy.enum.category) {
    return localizeCategoryName(row.label, row.labelNames, locale) ?? resolveKey(row, groupBy);
  }
  return row.label ?? resolveKey(row, groupBy);
};

const pct = (value: number, total: number): number => (total === 0 ? 0 : roundMoney((value / total) * 100));

export const shapeAggregateResult = (
  rows: readonly AggregateDbRow[],
  groupBy: AggregateGroupBy,
  sort: AggregateSort,
  locale: Locale,
  limit?: number,
): CurrencyBlock[] =>
  R.pipe(
    rows,
    R.groupBy((r) => r.currency),
    R.entries(),
    R.map(([currency, currencyRows]): CurrencyBlock => {
      const total = roundMoney(R.sumBy(currencyRows, (r) => r.value));
      const sorted =
        sort === AggregateSort.enum.asc
          ? R.sortBy(currencyRows, (r) => r.value)
          : R.sortBy(currencyRows, [(r) => r.value, 'desc']);
      const limited = R.isNonNullish(limit) ? R.take(sorted, limit) : sorted;
      const shapedRows: AggregateRow[] = limited.map((r) => ({
        key: resolveKey(r, groupBy),
        label: resolveLabel(r, groupBy, locale),
        value: roundMoney(r.value),
        count: r.count,
        pct: pct(r.value, total),
      }));
      return { currency: currency as CurrencyCode, total, rows: shapedRows };
    }),
    R.sortBy((b) => b.currency),
  );
