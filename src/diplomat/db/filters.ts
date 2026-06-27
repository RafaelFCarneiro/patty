import { sql } from 'drizzle-orm'
import type { AggregateGroupBy, AggregateMetric } from '../../models/aggregate.js'
import type { TransactionStatus } from '../../models/transaction.js'

export type CommonFilters = {
  from: string | null
  to: string | null
  type: string | null
  accountId: string | null
  categoryId: string | null
  tagNames: string[]
}

export type SearchFilters = CommonFilters & {
  status: TransactionStatus | null
  text: string | null
  subCategoryId: string | null
  limit: number
}

export type AggregateFilters = CommonFilters & {
  groupBy: AggregateGroupBy
  metric: AggregateMetric
}

export const buildCommonWhere = (filters: CommonFilters): ReturnType<typeof sql>[] => {
  const conditions: ReturnType<typeof sql>[] = []
  if (filters.from)       conditions.push(sql`t.date >= ${filters.from}`)
  if (filters.to)         conditions.push(sql`t.date < ${filters.to}`)
  if (filters.type)       conditions.push(sql`t.type = ${filters.type}`)
  if (filters.accountId)  conditions.push(sql`(t.from_account_id = ${filters.accountId} OR t.to_account_id = ${filters.accountId})`)
  if (filters.categoryId) conditions.push(sql`t.category_id = ${filters.categoryId}`)
  if (filters.tagNames.length > 0) {
    const placeholders = sql.join(filters.tagNames.map((n) => sql`${n}`), sql`, `)
    conditions.push(sql`EXISTS (
      SELECT 1 FROM transaction_tags tt2
      JOIN tags tg2 ON tg2.id = tt2.tag_id
      WHERE tt2.transaction_id = t.id AND tg2.name IN (${placeholders})
    )`)
  }
  return conditions
}
