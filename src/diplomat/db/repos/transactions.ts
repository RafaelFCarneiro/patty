import { sql, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import * as transactionAdapters from '../../../adapters/transactions.js';
import { expectPresent, rowNotFoundAfterWrite } from '../present.js';
import { SortDirection, type CursorKey } from '../../../models/page.js';
import {
  TransactionType,
  type CategorySpend,
  type ResolvedSearchRefs,
  type SearchTransactions,
  type RawTransactionView,
  type TransactionSortField,
} from '../../../models/transaction.js';
import type { SummaryRow } from '../../../models/summary.js';
import { AggregateDbRowSchema, type AggregateDbRow } from '../../../wire/db/aggregate.js';
import { CategorySpendRowSchema, ORDER_BY_COLUMN, SummaryRowSchema } from '../../../wire/db/transactions.js';
import { GROUP_BY_MAP, METRIC_MAP } from '../queries/aggregateWhitelist.js';
import type { Db } from '../driver.js';
import { buildCommonWhere, buildSearchWhere, toSearchFilters, type AggregateFilters } from '../queries/filters.js';
import { transactions } from '../schema.js';
import { fullTxSelect } from '../queries/transactionSelect.js';
import { txPredicates } from '../queries/txPredicates.js';
import { versionedTableApplier, type EntityApplier, type Tx } from '../effects.js';

// search_transactions' includeTotal COUNT(*) row — decoded like every other SQL row (ADR
// "decode at the boundary" invariant), not trusted on the strength of a type parameter alone.
// Local to this one query (unlike SummaryRowSchema/AggregateDbRowSchema, whose row shapes are
// genuinely reused in logic/summary.ts and logic/aggregate.ts), so it stays here rather than
// being exported as a wire/db "storage contract" with no second consumer.
const SearchCountRowSchema = z.object({ count: z.number().int() });

// `Db | Tx`: `fetchTx` also runs inside the `runEffects` transaction (it backs the registered
// `readBack` below), so it accepts either the top-level `Db` handle or the `Tx` a `db.transaction`
// callback receives — the same query-builder surface (select/insert/update/delete/all) either way.
type Executor = Db | Tx;

const fetchTx = async (db: Executor, id: string): Promise<RawTransactionView | null> => {
  const [row] = await db.all<Record<string, unknown>>(fullTxSelect(sql`t.id = ${id}`));
  return row ? transactionAdapters.dbToModel(row) : null;
};

/** Tiebreaker (t.id) follows `dir` — one uniform direction across the composite key, which is
 *  what keeps the keyset predicate below stable (ADR-014 Decision 1). `sql.raw` is safe here:
 *  the column name always comes from the ORDER_BY_COLUMN whitelist, never from caller input. */
const orderByClause = (sort: TransactionSortField, dir: SortDirection): SQL => {
  const column = sql.raw(ORDER_BY_COLUMN[sort]);
  const direction = dir === SortDirection.enum.asc ? sql`ASC` : sql`DESC`;
  return sql`${column} ${direction}, t.id ${direction}`;
};

/** Expanded keyset predicate, consistent with `orderByClause` per key component (ADR-014):
 *  `(col < ? OR (col = ? AND t.id < ?))` for `dir: desc`, `>` for `dir: asc`. Values are always
 *  parameter-bound; only the column name (via `sql.raw` off the ORDER_BY_COLUMN whitelist) and
 *  the comparator are structural. */
const keysetPredicate = (sort: TransactionSortField, dir: SortDirection, key: CursorKey): SQL => {
  const column = sql.raw(ORDER_BY_COLUMN[sort]);
  const cmp = dir === SortDirection.enum.asc ? sql`>` : sql`<`;
  return sql`(${column} ${cmp} ${key.value} OR (${column} = ${key.value} AND t.id ${cmp} ${key.id}))`;
};

/** What counts as "correlated" to a credit card: a purchase on the card itself (`credit_card_id`)
 *  or any movement on its own internal liability account (`from_account_id`/`to_account_id`),
 *  including the bill-payment transfer. `alias` lets a caller qualify the columns for a joined
 *  query. Exported for `creditCardsRepo.countCorrelated`, which also filters the transactions
 *  table by this predicate. */
export const correlatedToCard = (cardId: string, accountId: string, alias = ''): SQL => {
  const col = (name: string) => sql.raw(alias ? `${alias}.${name}` : name);
  return sql`${col('credit_card_id')} = ${cardId} OR ${col('from_account_id')} = ${accountId} OR ${col('to_account_id')} = ${accountId}`;
};

export type TransactionsRepo = {
  getById: (id: string) => Promise<RawTransactionView | null>;
  /** Every transaction correlated to a credit card — card purchases (`creditCardId`) and any
   *  movement on its internal liability account (`fromAccountId`/`toAccountId`), including the
   *  bill-payment transfer. Version-carrying — `deleteCreditCard` decides which of these to remove
   *  as its own `Persistable`s. */
  findAllCorrelatedToCard: (cardId: string, accountId: string) => Promise<RawTransactionView[]>;
  /** Keyset page: fetches one extra row (LIMIT n+1) to derive `hasMore` without a COUNT query.
   *  Receives the model plus the refs the controller had to resolve via I/O; shaping that pair
   *  into the flat SQL-filter object (`toSearchFilters`) happens in here, not at the call site. */
  search: (
    input: SearchTransactions,
    refs: ResolvedSearchRefs,
  ) => Promise<{ items: RawTransactionView[]; hasMore: boolean }>;
  /** Same-WHERE count for `includeTotal` — no cursor/ORDER BY/LIMIT applied. */
  count: (input: SearchTransactions, refs: ResolvedSearchRefs) => Promise<number>;
  aggregate: (filters: AggregateFilters) => Promise<AggregateDbRow[]>;
  summaryRows: (from: string, to: string) => Promise<SummaryRow[]>;
  /** Aggregated pending amounts for an account dated on/before asOf. */
  pendingBalanceParts: (
    accountId: string,
    asOf: string,
  ) => Promise<{
    income: number;
    expenses: number;
    transfersIn: number;
    transfersOut: number;
  }>;
  /** Expense spend over `[from, to)`, grouped by this repo's own dimensions (currency, category,
   *  sub-category), split into effective/pending sums — no knowledge of budgets or any other
   *  correlating aggregate (ADR-028). */
  spendByCategory: (from: string, to: string) => Promise<CategorySpend[]>;
};

export const transactionsRepo = (db: Db): TransactionsRepo => ({
  getById: (id) => fetchTx(db, id),

  findAllCorrelatedToCard: async (cardId, accountId) => {
    const rows = await db.all<Record<string, unknown>>(fullTxSelect(correlatedToCard(cardId, accountId, 't')));
    return rows.map(transactionAdapters.dbToModel);
  },

  // search/count's status/type filters (buildSearchWhere) stay a plain equality against whatever
  // value the caller passed — no fixed policy predicate here to extract onto txPredicates.
  search: async (input, refs) => {
    const filters = toSearchFilters(input, refs);
    const conditions = buildSearchWhere(filters);
    if (filters.cursorKey) conditions.push(keysetPredicate(filters.sort, filters.dir, filters.cursorKey));

    const where = conditions.length > 0 ? sql.join(conditions, sql` AND `) : sql`1=1`;
    const rows = await db.all<Record<string, unknown>>(sql`
      ${fullTxSelect(where)}
      ORDER BY ${orderByClause(filters.sort, filters.dir)}
      LIMIT ${filters.limit + 1}
    `);

    const hasMore = rows.length > filters.limit;
    return { items: rows.slice(0, filters.limit).map(transactionAdapters.dbToModel), hasMore };
  },

  count: async (input, refs) => {
    const filters = toSearchFilters(input, refs);
    const conditions = buildSearchWhere(filters);
    const where = conditions.length > 0 ? sql.join(conditions, sql` AND `) : sql`1=1`;
    // COUNT(*) always returns exactly one row (even for zero matches) — an absent row would be a
    // genuine driver-level anomaly, not an expected case, so this is allowed to throw on it.
    const [row] = await db.all<Record<string, unknown>>(
      sql`SELECT COUNT(*) AS count FROM transactions t WHERE ${where}`,
    );
    return SearchCountRowSchema.parse(row).count;
  },

  aggregate: async (filters) => {
    const g = GROUP_BY_MAP[filters.groupBy];
    const metric = METRIC_MAP[filters.metric];

    const conditions = buildCommonWhere(filters);
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
  },

  summaryRows: async (from, to) => {
    const rows = await db.all<Record<string, unknown>>(sql`
      SELECT t.currency, t.type, c.name AS category, c.names AS category_names,
             SUM(t.amount) AS total, COUNT(*) AS count
      FROM transactions t
      LEFT JOIN categories c ON c.id = t.category_id
      WHERE t.date >= ${from} AND t.date < ${to}
        AND ${txPredicates.nonTransfer()}
        AND ${txPredicates.effective()}
      GROUP BY t.currency, t.type, c.id
    `);
    return rows.map((r) => SummaryRowSchema.parse(r));
  },

  pendingBalanceParts: async (accountId, asOf) => {
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
          WHERE t2.to_account_id = ${accountId}
            AND t2.type = ${TransactionType.enum.transfer}
            AND ${txPredicates.pending('t2')}
            AND t2.date <= ${asOf}
        ), 0) AS transfers_in
      FROM transactions t
      WHERE t.from_account_id = ${accountId}
        AND ${txPredicates.pending()}
        AND t.date <= ${asOf}
    `);
    return {
      income: row?.income ?? 0,
      expenses: row?.expenses ?? 0,
      transfersIn: row?.transfers_in ?? 0,
      transfersOut: row?.transfers_out ?? 0,
    };
  },

  // Excludes uncategorized spend — it can never match a budget target, and keeps `category_id`
  // non-nullable on `CategorySpend`.
  spendByCategory: async (from, to) => {
    const rows = await db.all<Record<string, unknown>>(sql`
      SELECT t.currency, t.category_id, t.subcategory_id,
             COALESCE(SUM(CASE WHEN ${txPredicates.effective()} THEN t.amount END), 0) AS effective,
             COALESCE(SUM(CASE WHEN ${txPredicates.pending()} THEN t.amount END), 0) AS pending
      FROM transactions t
      WHERE ${txPredicates.expense()}
        AND ${txPredicates.committed()}
        AND t.date >= ${from} AND t.date < ${to}
        AND t.category_id IS NOT NULL
      GROUP BY t.currency, t.category_id, t.subcategory_id
    `);
    return rows.map((r) => CategorySpendRowSchema.parse(r));
  },
});

/** The entity's post-write projection (`ReadBack`): the actually-persisted, display-joined view
 *  (account/category names), decoded — what an idempotency-aware flow's `response` reflects
 *  without a second read of its own. Reads by the id the engine already resolved: on an
 *  idempotent-duplicate insert that's the surviving row's, never the discarded mint. */
const readBack = async (tx: Tx, id: string): Promise<RawTransactionView> =>
  expectPresent(await fetchTx(tx, id), rowNotFoundAfterWrite('transactions', 'write'));

/** Collapsed to a registration (ADR-023 decision 5): the idempotency column and post-write
 *  projection are declared config; nothing entity-specific decides anything here. */
export const transactionApplier: EntityApplier = versionedTableApplier(transactions, {
  idempotencyColumn: 'idempotencyKey',
  readBack,
});
