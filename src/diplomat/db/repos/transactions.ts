import { sql, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import * as transactionAdapters from '../../../adapters/transactions.js';
import { expectPresent, rowNotFoundAfterWrite } from '../present.js';
import { SortDirection, type CursorKey } from '../../../models/page.js';
import {
  TransactionType,
  type CategorySpend,
  type CategoryWindowedSpend,
  type ResolvedSearchRefs,
  type SearchTransactions,
  type RawTransactionView,
  type TransactionSortField,
} from '../../../models/transaction.js';
import type { SummaryRow } from '../../../models/summary.js';
import { AggregateDbRowSchema, type AggregateDbRow } from '../../../wire/db/aggregate.js';
import {
  CategorySpendRowSchema,
  CategoryWindowedSpendRowSchema,
  ORDER_BY_COLUMN,
  SummaryRowSchema,
} from '../../../wire/db/transactions.js';
import { GROUP_BY_MAP, METRIC_MAP } from '../queries/aggregateWhitelist.js';
import type { Db } from '../driver.js';
import { buildCommonWhere, buildSearchWhere, toSearchFilters, type AggregateFilters } from '../queries/filters.js';
import { ownedBy, type RepoScope } from '../queries/scope.js';
import { transactions } from '../schema.js';
import { fullTxSelect } from '../queries/transactionSelect.js';
import { txPredicates } from '../queries/txPredicates.js';
import { ownedTableApplier, type EntityApplier, type Tx } from '../effects.js';

const SearchCountRowSchema = z.object({ count: z.number().int() });

type Executor = Db | Tx;

const fetchTx = async (db: Executor, userId: string, id: string): Promise<RawTransactionView | null> => {
  const [row] = await db.all<Record<string, unknown>>(fullTxSelect(userId, sql`t.id = ${id}`));
  return row ? transactionAdapters.dbToModel(row) : null;
};

const orderByClause = (sort: TransactionSortField, dir: SortDirection): SQL => {
  const column = sql.raw(ORDER_BY_COLUMN[sort]);
  const direction = dir === SortDirection.enum.asc ? sql`ASC` : sql`DESC`;
  return sql`${column} ${direction}, t.id ${direction}`;
};

const keysetPredicate = (sort: TransactionSortField, dir: SortDirection, key: CursorKey): SQL => {
  const column = sql.raw(ORDER_BY_COLUMN[sort]);
  const cmp = dir === SortDirection.enum.asc ? sql`>` : sql`<`;
  return sql`(${column} ${cmp} ${key.value} OR (${column} = ${key.value} AND t.id ${cmp} ${key.id}))`;
};

export const correlatedToCard = (cardId: string, accountId: string, alias = ''): SQL => {
  const col = (name: string) => sql.raw(alias ? `${alias}.${name}` : name);
  return sql`${col('credit_card_id')} = ${cardId} OR ${col('from_account_id')} = ${accountId} OR ${col('to_account_id')} = ${accountId}`;
};

export type TransactionsRepo = {
  getById: (id: string) => Promise<RawTransactionView | null>;
  findAllCorrelatedToCard: (cardId: string, accountId: string) => Promise<RawTransactionView[]>;
  search: (
    input: SearchTransactions,
    refs: ResolvedSearchRefs,
  ) => Promise<{ items: RawTransactionView[]; hasMore: boolean }>;
  count: (input: SearchTransactions, refs: ResolvedSearchRefs) => Promise<number>;
  aggregate: (filters: AggregateFilters) => Promise<AggregateDbRow[]>;
  summaryRows: (from: string, to: string) => Promise<SummaryRow[]>;
  pendingBalanceParts: (
    accountId: string,
    asOf: string,
  ) => Promise<{
    income: number;
    expenses: number;
    transfersIn: number;
    transfersOut: number;
  }>;
  spendByCategory: (from: string, to: string) => Promise<CategorySpend[]>;
  spendByCategoryWindowed: (
    baselineFrom: string,
    currentFrom: string,
    currentTo: string,
  ) => Promise<CategoryWindowedSpend[]>;
};

const findAllCorrelatedToCard = async (
  { db, userId }: RepoScope,
  cardId: string,
  accountId: string,
): ReturnType<TransactionsRepo['findAllCorrelatedToCard']> => {
  const rows = await db.all<Record<string, unknown>>(fullTxSelect(userId, correlatedToCard(cardId, accountId, 't')));
  return rows.map(transactionAdapters.dbToModel);
};

const search = async (
  { db, userId }: RepoScope,
  input: SearchTransactions,
  refs: ResolvedSearchRefs,
): ReturnType<TransactionsRepo['search']> => {
  const filters = toSearchFilters(input, refs);
  const conditions = buildSearchWhere(filters, userId);
  if (filters.cursorKey) conditions.push(keysetPredicate(filters.sort, filters.dir, filters.cursorKey));

  const where = sql.join(conditions, sql` AND `);
  const rows = await db.all<Record<string, unknown>>(sql`
      ${fullTxSelect(userId, where)}
      ORDER BY ${orderByClause(filters.sort, filters.dir)}
      LIMIT ${filters.limit + 1}
    `);

  const hasMore = rows.length > filters.limit;
  return { items: rows.slice(0, filters.limit).map(transactionAdapters.dbToModel), hasMore };
};

const count = async (
  { db, userId }: RepoScope,
  input: SearchTransactions,
  refs: ResolvedSearchRefs,
): ReturnType<TransactionsRepo['count']> => {
  const filters = toSearchFilters(input, refs);
  const where = sql.join(buildSearchWhere(filters, userId), sql` AND `);
  const [row] = await db.all<Record<string, unknown>>(sql`SELECT COUNT(*) AS count FROM transactions t WHERE ${where}`);
  return SearchCountRowSchema.parse(row).count;
};

const aggregate = async (
  { db, userId }: RepoScope,
  filters: AggregateFilters,
): ReturnType<TransactionsRepo['aggregate']> => {
  const g = GROUP_BY_MAP[filters.groupBy];
  const metric = METRIC_MAP[filters.metric];

  const conditions = buildCommonWhere(filters, userId);
  conditions.push(txPredicates.effective());
  conditions.push(txPredicates.nonTransfer());

  const where = sql.join(conditions, sql` AND `);

  const labelNames = g.labelNames ? sql`, ${g.labelNames} AS label_names` : sql`, NULL AS label_names`;

  const rows = await db.all<Record<string, unknown>>(sql`
      SELECT ${g.expr} AS key, ${g.label} AS label${labelNames},
             t.currency, ${metric} AS value, COUNT(*) AS count
      FROM transactions t
      ${g.join}
      WHERE ${where}
      GROUP BY t.currency, key
    `);

  return rows.map((r) => AggregateDbRowSchema.parse(r));
};

const summaryRows = async (
  { db, userId }: RepoScope,
  from: string,
  to: string,
): ReturnType<TransactionsRepo['summaryRows']> => {
  const rows = await db.all<Record<string, unknown>>(sql`
      SELECT t.currency, t.type, c.name AS category, c.names AS category_names,
             SUM(t.amount) AS total, COUNT(*) AS count
      FROM transactions t
      LEFT JOIN categories c ON c.id = t.category_id
      WHERE ${ownedBy(userId, 't')}
        AND t.date >= ${from} AND t.date < ${to}
        AND ${txPredicates.nonTransfer()}
        AND ${txPredicates.effective()}
      GROUP BY t.currency, t.type, c.id
    `);
  return rows.map((r) => SummaryRowSchema.parse(r));
};

const pendingBalanceParts = async (
  { db, userId }: RepoScope,
  accountId: string,
  asOf: string,
): ReturnType<TransactionsRepo['pendingBalanceParts']> => {
  const [row] = await db.all<{
    income: number;
    expenses: number;
    transfers_out: number;
    transfers_in: number;
  }>(sql`
      SELECT
        COALESCE(SUM(CASE WHEN t.type = ${TransactionType.enum.income}   THEN t.amount ELSE 0 END), 0) AS income,
        COALESCE(SUM(CASE WHEN t.type = ${TransactionType.enum.expense}  THEN t.amount ELSE 0 END), 0) AS expenses,
        COALESCE(SUM(CASE WHEN t.type = ${TransactionType.enum.transfer} THEN t.amount ELSE 0 END), 0) AS transfers_out,
        COALESCE((
          SELECT SUM(t2.amount) FROM transactions t2
          WHERE ${ownedBy(userId, 't2')}
            AND t2.to_account_id = ${accountId}
            AND t2.type = ${TransactionType.enum.transfer}
            AND ${txPredicates.pending('t2')}
            AND t2.date <= ${asOf}
        ), 0) AS transfers_in
      FROM transactions t
      WHERE ${ownedBy(userId, 't')}
        AND t.from_account_id = ${accountId}
        AND ${txPredicates.pending()}
        AND t.date <= ${asOf}
    `);
  return {
    income: row?.income ?? 0,
    expenses: row?.expenses ?? 0,
    transfersIn: row?.transfers_in ?? 0,
    transfersOut: row?.transfers_out ?? 0,
  };
};

const spendByCategory = async (
  { db, userId }: RepoScope,
  from: string,
  to: string,
): ReturnType<TransactionsRepo['spendByCategory']> => {
  const rows = await db.all<Record<string, unknown>>(sql`
      SELECT t.currency, t.category_id, t.subcategory_id,
             COALESCE(SUM(CASE WHEN ${txPredicates.effective()} THEN t.amount END), 0) AS effective,
             COALESCE(SUM(CASE WHEN ${txPredicates.pending()} THEN t.amount END), 0) AS pending
      FROM transactions t
      WHERE ${ownedBy(userId, 't')}
        AND ${txPredicates.expense()}
        AND ${txPredicates.committed()}
        AND t.date >= ${from} AND t.date < ${to}
        AND t.category_id IS NOT NULL
      GROUP BY t.currency, t.category_id, t.subcategory_id
    `);
  return rows.map((r) => CategorySpendRowSchema.parse(r));
};

const spendByCategoryWindowed = async (
  { db, userId }: RepoScope,
  baselineFrom: string,
  currentFrom: string,
  currentTo: string,
): ReturnType<TransactionsRepo['spendByCategoryWindowed']> => {
  const rows = await db.all<Record<string, unknown>>(sql`
      SELECT t.currency, t.category_id, t.subcategory_id,
             SUM(CASE WHEN t.date >= ${currentFrom} THEN t.amount ELSE 0 END) AS current,
             SUM(CASE WHEN t.date < ${currentFrom} THEN t.amount ELSE 0 END) AS baseline_total
      FROM transactions t
      WHERE ${ownedBy(userId, 't')}
        AND ${txPredicates.expense()}
        AND ${txPredicates.effective()}
        AND t.date >= ${baselineFrom} AND t.date < ${currentTo}
        AND t.category_id IS NOT NULL
      GROUP BY t.currency, t.category_id, t.subcategory_id
    `);
  return rows.map((r) => CategoryWindowedSpendRowSchema.parse(r));
};

export const transactionsRepo = (db: Db, userId: string): TransactionsRepo => {
  const scope: RepoScope = { db, userId };
  return {
    getById: (id) => fetchTx(db, userId, id),
    findAllCorrelatedToCard: (cardId, accountId) => findAllCorrelatedToCard(scope, cardId, accountId),
    search: (input, refs) => search(scope, input, refs),
    count: (input, refs) => count(scope, input, refs),
    aggregate: (filters) => aggregate(scope, filters),
    summaryRows: (from, to) => summaryRows(scope, from, to),
    pendingBalanceParts: (accountId, asOf) => pendingBalanceParts(scope, accountId, asOf),
    spendByCategory: (from, to) => spendByCategory(scope, from, to),
    spendByCategoryWindowed: (baselineFrom, currentFrom, currentTo) =>
      spendByCategoryWindowed(scope, baselineFrom, currentFrom, currentTo),
  };
};

const readBackFor =
  (userId: string) =>
  async (tx: Tx, id: string): Promise<RawTransactionView> =>
    expectPresent(await fetchTx(tx, userId, id), rowNotFoundAfterWrite('transactions', 'write'));

export const transactionApplier = (userId: string): EntityApplier =>
  ownedTableApplier(transactions, userId, { readBack: readBackFor(userId) });
