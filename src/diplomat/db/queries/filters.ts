import { sql } from 'drizzle-orm';
import type { AggregateGroupBy, AggregateMetric } from '../../../models/aggregate.js';
import type { CursorKey, SortDirection } from '../../../models/page.js';
import type {
  ResolvedSearchRefs,
  SearchTransactions,
  TransactionSortField,
  TransactionStatus,
} from '../../../models/transaction.js';
import { toMatchQuery } from './fts.js';
import { ownedBy } from './scope.js';

export type CommonFilters = {
  from: string | null;
  to: string | null;
  type: string | null;
  accountId: string | null;
  categoryId: string | null;
  tagNames: string[];
};

/** Filters that narrow the result set — shared by the paged `search` and its same-WHERE `count`. */
export type SearchConditionFilters = CommonFilters & {
  status: TransactionStatus | null;
  text: string | null;
  subCategoryId: string | null;
};

export type SearchFilters = SearchConditionFilters & {
  limit: number;
  sort: TransactionSortField;
  dir: SortDirection;
  cursorKey: CursorKey | null;
};

export type AggregateFilters = CommonFilters & {
  groupBy: AggregateGroupBy;
  metric: AggregateMetric;
};

/** The one model→SQL-filter shaping step for search_transactions — owned here (diplomat/db), not
 *  by the controller, which hands the repo the model plus `ResolvedSearchRefs` and never builds
 *  this flat shape itself (mirrors `transactionsRepo.create` calling `modelToDb` internally). */
export const toSearchFilters = (input: SearchTransactions, refs: ResolvedSearchRefs): SearchFilters => ({
  from: refs.from ?? input.from ?? null,
  to: refs.to ?? input.to ?? null,
  type: input.type ?? null,
  status: input.status ?? null,
  text: input.text ?? null,
  accountId: refs.accountId,
  categoryId: refs.categoryId,
  subCategoryId: refs.subCategoryId,
  tagNames: input.tags ?? [],
  limit: input.limit,
  sort: input.sort,
  dir: input.dir,
  cursorKey: refs.cursorKey,
});

export const buildCommonWhere = (filters: CommonFilters, userId: string): ReturnType<typeof sql>[] => {
  const conditions: ReturnType<typeof sql>[] = [ownedBy(userId, 't')];
  if (filters.from) conditions.push(sql`t.date >= ${filters.from}`);
  if (filters.to) conditions.push(sql`t.date < ${filters.to}`);
  if (filters.type) conditions.push(sql`t.type = ${filters.type}`);
  if (filters.accountId)
    conditions.push(sql`(t.from_account_id = ${filters.accountId} OR t.to_account_id = ${filters.accountId})`);
  if (filters.categoryId) conditions.push(sql`t.category_id = ${filters.categoryId}`);
  if (filters.tagNames.length > 0) {
    const placeholders = sql.join(
      filters.tagNames.map((n) => sql`${n}`),
      sql`, `,
    );
    conditions.push(sql`EXISTS (
      SELECT 1 FROM transaction_tags tt2
      JOIN tags tg2 ON tg2.id = tt2.tag_id
      WHERE tt2.transaction_id = t.id AND tg2.name IN (${placeholders})
    )`);
  }
  return conditions;
};

/** search_transactions' full WHERE — shared by the paged row query and its opt-in `count`
 *  (ADR-011 § shared filter WHERE-builder); only the projection/keyset/ORDER-BY tail differs. */
export const buildSearchWhere = (filters: SearchConditionFilters, userId: string): ReturnType<typeof sql>[] => {
  const conditions = buildCommonWhere(filters, userId);
  if (filters.status) conditions.push(sql`t.status = ${filters.status}`);
  if (filters.subCategoryId) conditions.push(sql`t.subcategory_id = ${filters.subCategoryId}`);
  if (filters.text) {
    const matchQuery = toMatchQuery(filters.text);
    if (matchQuery !== null) {
      conditions.push(sql`t.rowid IN (SELECT rowid FROM transactions_fts WHERE transactions_fts MATCH ${matchQuery})`);
    }
  }
  return conditions;
};
