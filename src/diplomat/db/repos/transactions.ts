import { eq, inArray, sql, type SQL } from 'drizzle-orm';
import * as transactionAdapters from '../../../adapters/transactions.js';
import { expectPresent, rowNotFoundAfterWrite } from '../present.js';
import { SortDirection, type CursorKey } from '../../../models/page.js';
import {
  TransactionSortField,
  TransactionStatus,
  TransactionType,
  type CreateTxResult,
  type SearchTransactions,
  type Transaction,
  type RawTransactionView,
  type TransactionPatch,
} from '../../../models/transaction.js';
import type { SummaryRow } from '../../../models/summary.js';
import { AggregateDbRowSchema, type AggregateDbRow } from '../../../wire/db/aggregate.js';
import { SummaryRowSchema } from '../../../wire/db/transactions.js';
import { GROUP_BY_MAP, METRIC_MAP } from '../aggregateWhitelist.js';
import type { Db } from '../driver.js';
import {
  buildCommonWhere,
  buildSearchWhere,
  toSearchFilters,
  type AggregateFilters,
  type ResolvedSearchRefs,
} from '../filters.js';
import { merchants, tags, transactionTags, transactions } from '../schema.js';
import { ORDER_BY_COLUMN } from '../transactionOrderWhitelist.js';
import { fullTxSelect } from '../transactionSelect.js';

// Re-exported so controllers can reference this repo-contract parameter type via the documented
// "import type from diplomat/db/repos" exception (docs/architecture.md § Dependency direction),
// without importing diplomat/db/filters.js directly (controllers may not import diplomat/* modules).
export type { ResolvedSearchRefs } from '../filters.js';

const fetchTx = async (db: Db, id: string): Promise<RawTransactionView | null> => {
  const [row] = await db.all<Record<string, unknown>>(fullTxSelect(sql`t.id = ${id}`));
  return row ? transactionAdapters.dbToModel(row) : null;
};

const attachTags = async (db: Db, txId: string, tagNames: string[]): Promise<void> => {
  if (tagNames.length === 0) return;
  const matches = await db.select({ id: tags.id }).from(tags).where(inArray(tags.name, tagNames));
  if (matches.length === 0) return;
  await db
    .insert(transactionTags)
    .values(matches.map((tag) => ({ transactionId: txId, tagId: tag.id })))
    .onConflictDoNothing({ target: [transactionTags.transactionId, transactionTags.tagId] });
};

const replaceTags = async (db: Db, txId: string, tagNames: string[]): Promise<void> => {
  await db.delete(transactionTags).where(eq(transactionTags.transactionId, txId));
  await attachTags(db, txId, tagNames);
};

/** Tiebreaker (t.id) follows `dir` — one uniform direction across the composite key, which is
 *  what keeps the keyset predicate below stable (ADR-014 Decision 1). */
const orderByClause = (sort: TransactionSortField, dir: SortDirection): SQL => {
  const direction = dir === SortDirection.enum.asc ? sql`ASC` : sql`DESC`;
  return sql`${ORDER_BY_COLUMN[sort]} ${direction}, t.id ${direction}`;
};

/** Expanded keyset predicate, consistent with `orderByClause` per key component (ADR-014):
 *  `(col < ? OR (col = ? AND t.id < ?))` for `dir: desc`, `>` for `dir: asc`. Values are always
 *  parameter-bound; only the column fragment and comparator come from the ORDER_BY_COLUMN whitelist. */
const keysetPredicate = (sort: TransactionSortField, dir: SortDirection, key: CursorKey): SQL => {
  const column = ORDER_BY_COLUMN[sort];
  const cmp = dir === SortDirection.enum.asc ? sql`>` : sql`<`;
  return sql`(${column} ${cmp} ${key.value} OR (${column} = ${key.value} AND t.id ${cmp} ${key.id}))`;
};

export type TransactionsRepo = {
  /** Receives domain entity; model→db flattening happens here (adapters/transactions.ts). */
  create: (entity: Transaction, tagNames: string[]) => Promise<CreateTxResult>;
  getById: (id: string) => Promise<RawTransactionView | null>;
  update: (
    id: string,
    patch: TransactionPatch,
    refs: {
      accountId: string | null;
      categoryId: string | null;
      /** undefined = leave untouched; null = explicitly clear (decided by the controller). */
      subCategoryId: string | null | undefined;
      tagNames: string[] | null;
    },
  ) => Promise<RawTransactionView | null>;
  /** Flip status pending → effective. Returns null if the id does not exist. */
  confirm: (id: string) => Promise<RawTransactionView | null>;
  delete: (id: string) => Promise<boolean>;
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
};

export const transactionsRepo = (db: Db): TransactionsRepo => ({
  /** Idempotent create: INSERT OR IGNORE on idempotency_key. */
  create: async (entity, tagNames) => {
    const { props, refs } = transactionAdapters.modelToDb(entity);

    // Ensure merchant row exists before FK reference
    if (refs.merchantKey) {
      await db.insert(merchants).values({ key: refs.merchantKey }).onConflictDoNothing();
    }

    const result = await db
      .insert(transactions)
      .values({
        id: props.id,
        description: props.description,
        amount: props.amount,
        type: props.type,
        status: props.status,
        date: props.date,
        currency: props.currency,
        source: props.source,
        idempotencyKey: props.idempotencyKey,
        classificationMethod: props.classificationMethod,
        confidence: props.confidence,
        rawInput: props.rawInput ?? null,
        note: props.note ?? null,
        fromAccountId: refs.accountId,
        toAccountId: refs.toAccountId,
        creditCardId: refs.cardId,
        billId: refs.billId,
        categoryId: refs.categoryId,
        subcategoryId: refs.subCategoryId,
        merchantKey: refs.merchantKey,
      })
      .onConflictDoNothing({ target: transactions.idempotencyKey });

    const created = (result.rowsAffected ?? 0) > 0;

    let transaction: RawTransactionView | null;
    if (created) {
      if (tagNames.length > 0) await attachTags(db, entity.id, tagNames);
      transaction = await fetchTx(db, entity.id);
    } else {
      // Duplicate: the new entity.id was never inserted; find the existing row by idempotency key.
      const [existing] = await db.all<Record<string, unknown>>(
        fullTxSelect(sql`t.idempotency_key = ${props.idempotencyKey}`),
      );
      transaction = existing ? transactionAdapters.dbToModel(existing) : null;
    }

    return { transaction: expectPresent(transaction, rowNotFoundAfterWrite('transactions', 'write')), created };
  },

  getById: (id) => fetchTx(db, id),

  update: async (id, patch, refs) => {
    const props = transactionAdapters.patchToDb(patch);

    const setData = {
      ...(props.description !== undefined && { description: props.description }),
      ...(props.amount !== undefined && { amount: props.amount }),
      ...(props.type !== undefined && { type: props.type }),
      ...(props.status !== undefined && { status: props.status }),
      ...(props.date !== undefined && { date: props.date }),
      ...(props.currency !== undefined && { currency: props.currency }),
      ...(props.classificationMethod !== undefined && { classificationMethod: props.classificationMethod }),
      ...(props.confidence !== undefined && { confidence: props.confidence }),
      ...(props.note !== undefined && { note: props.note }),
      ...(refs.accountId !== null && { fromAccountId: refs.accountId }),
      ...(refs.categoryId !== null && { categoryId: refs.categoryId }),
      // undefined = caller left it untouched; null = caller explicitly clears it
      // (e.g. controller clears a stale sub-category when only the category changes).
      ...(refs.subCategoryId !== undefined && { subcategoryId: refs.subCategoryId }),
    };
    if (Object.keys(setData).length > 0) {
      await db.update(transactions).set(setData).where(eq(transactions.id, id));
    }

    if (refs.tagNames !== null) {
      await replaceTags(db, id, refs.tagNames);
    }

    return fetchTx(db, id);
  },

  confirm: async (id) => {
    await db
      .update(transactions)
      .set({ status: TransactionStatus.enum.effective })
      .where(sql`${transactions.id} = ${id} AND ${transactions.status} = ${TransactionStatus.enum.pending}`);
    return fetchTx(db, id);
  },

  delete: async (id) => {
    const result = await db.delete(transactions).where(eq(transactions.id, id));
    return (result.rowsAffected ?? 0) > 0;
  },

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
    const [row] = await db.all<{ count: number }>(sql`SELECT COUNT(*) AS count FROM transactions t WHERE ${where}`);
    return row?.count ?? 0;
  },

  aggregate: async (filters) => {
    const g = GROUP_BY_MAP[filters.groupBy];
    const metric = METRIC_MAP[filters.metric];

    const conditions = buildCommonWhere(filters);
    conditions.push(sql`t.status = ${TransactionStatus.enum.effective}`);
    conditions.push(sql`t.type != ${TransactionType.enum.transfer}`);

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
        AND t.type != ${TransactionType.enum.transfer}
        AND t.status = ${TransactionStatus.enum.effective}
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
            AND t2.status = ${TransactionStatus.enum.pending}
            AND t2.date <= ${asOf}
        ), 0) AS transfers_in
      FROM transactions t
      WHERE t.from_account_id = ${accountId}
        AND t.status = ${TransactionStatus.enum.pending}
        AND t.date <= ${asOf}
    `);
    return {
      income: row?.income ?? 0,
      expenses: row?.expenses ?? 0,
      transfersIn: row?.transfers_in ?? 0,
      transfersOut: row?.transfers_out ?? 0,
    };
  },
});
