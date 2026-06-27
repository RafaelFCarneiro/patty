import { z } from 'zod'
import { IsoDate, PeriodSchema } from './date.js'
import { CurrencyCode } from './money.js'
import { MovementType } from './transaction.js'

export const AggregateGroupBy = z.enum(['category', 'account', 'tag', 'month', 'merchant'])
export type AggregateGroupBy = z.infer<typeof AggregateGroupBy>

export const AggregateMetric = z.enum(['sum', 'count', 'avg'])
export type AggregateMetric = z.infer<typeof AggregateMetric>

export const AggregateSort = z.enum(['asc', 'desc'])
export type AggregateSort = z.infer<typeof AggregateSort>

export const AggregateSpendingSchema = z.object({
  groupBy: AggregateGroupBy.describe('Dimension to group by: category, account, tag, month, or merchant'),
  metric: AggregateMetric.optional().describe('Aggregation metric: sum, count, or avg of amount'),
  month: PeriodSchema.shape.month.optional(),
  year: PeriodSchema.shape.year.optional(),
  from: IsoDate.optional().describe('Start date (inclusive, YYYY-MM-DD) — alternative to month/year'),
  to: IsoDate.optional().describe('End date (inclusive, YYYY-MM-DD) — alternative to month/year'),
  account: z.string().min(1).optional().describe('Filter by account name'),
  category: z.string().min(1).optional().describe('Filter by category name'),
  type: MovementType.optional().describe('Filter by movement type: expense or income'),
  tags: z.array(z.string().min(1)).optional().describe('Filter to transactions having any of these tags'),
  limit: z.number().int().min(1).max(100).optional().describe('Return only the top-N rows per currency'),
  sort: AggregateSort.optional().describe('Sort order by metric value: asc or desc'),
})
export type AggregateSpending = z.infer<typeof AggregateSpendingSchema>

const AggregateRowSchema = z.object({
  key: z.string().describe('Group key (category id, account id, tag name, YYYY-MM, merchant key)'),
  label: z.string().describe('Human-readable label (locale-resolved for categories)'),
  value: z.number().describe('Metric value'),
  count: z.number().int().describe('Number of transactions in this group'),
  pct: z.number().describe('Percentage of the currency total'),
})
export type AggregateRow = z.infer<typeof AggregateRowSchema>

const CurrencyBlockSchema = z.object({
  currency: CurrencyCode,
  total: z.number().describe('Sum of all row values for this currency'),
  rows: z.array(AggregateRowSchema),
})
export type CurrencyBlock = z.infer<typeof CurrencyBlockSchema>

export const AggregateResultSchema = z.object({
  groupBy: AggregateGroupBy,
  metric: AggregateMetric,
  currencies: z.array(CurrencyBlockSchema),
})
export type AggregateResult = z.infer<typeof AggregateResultSchema>
