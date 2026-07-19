import { and, eq, inArray, sql, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import * as transactionAdapters from '../../../adapters/transactions.js';
import type { TransactionRowEntity } from '../../../adapters/transactions.js';
import { expectPresent, rowNotFoundAfterWrite } from '../present.js';
import { SortDirection, type CursorKey } from '../../../models/page.js';
import {
  TransactionStatus,
  TransactionType,
  type ResolvedSearchRefs,
  type SearchTransactions,
  type RawTransactionView,
  type TransactionSortField,
} from '../../../models/transaction.js';
import type { SummaryRow } from '../../../models/summary.js';
import { AggregateDbRowSchema, type AggregateDbRow } from '../../../wire/db/aggregate.js';
import { ORDER_BY_COLUMN, SummaryRowSchema } from '../../../wire/db/transactions.js';
import { GROUP_BY_MAP, METRIC_MAP } from '../aggregateWhitelist.js';
import type { Db } from '../driver.js';
import { buildCommonWhere, buildSearchWhere, toSearchFilters, type AggregateFilters } from '../filters.js';
import { merchants, tags, transactionTags, transactions } from '../schema.js';
import { fullTxSelect } from '../transactionSelect.js';
import type { EntityApplier, Tx } from '../effects.js';

// search_transactions' includeTotal COUNT(*) row — decoded like every other SQL row (ADR
// "decode at the boundary" invariant), not trusted on the strength of a type parameter alone.
// Local to this one query (unlike SummaryRowSchema/AggregateDbRowSchema, whose row shapes are
// genuinely reused in logic/summary.ts and logic/aggregate.ts), so it stays here rather than
// being exported as a wire/db "storage contract" with no second consumer.
const SearchCountRowSchema = z.object({ count: z.number().int() });

// `Db | Tx`: every helper below also runs inside `transactionApplier`'s `runEffects` transaction,
// so each accepts either the top-level `Db` handle or the `Tx` a `db.transaction`
// callback receives — the same query-builder surface (select/insert/update/delete/all) either way.
type Executor = Db | Tx;

const fetchTx = async (db: Executor, id: string): Promise<RawTransactionView | null> => {
  const [row] = await db.all<Record<string, unknown>>(fullTxSelect(sql`t.id = ${id}`));
  return row ? transactionAdapters.dbToModel(row) : null;
};

const fetchTxByIdempotencyKey = async (db: Executor, idempotencyKey: string): Promise<RawTransactionView | null> => {
  const [row] = await db.all<Record<string, unknown>>(fullTxSelect(sql`t.idempotency_key = ${idempotencyKey}`));
  return row ? transactionAdapters.dbToModel(row) : null;
};

const attachTags = async (db: Executor, txId: string, tagNames: string[]): Promise<void> => {
  if (tagNames.length === 0) return;
  const matches = await db.select({ id: tags.id }).from(tags).where(inArray(tags.name, tagNames));
  if (matches.length === 0) return;
  await db
    .insert(transactionTags)
    .values(matches.map((tag) => ({ transactionId: txId, tagId: tag.id })))
    .onConflictDoNothing({ target: [transactionTags.transactionId, transactionTags.tagId] });
};

const replaceTags = async (db: Executor, txId: string, tagNames: string[]): Promise<void> => {
  await db.delete(transactionTags).where(eq(transactionTags.transactionId, txId));
  await attachTags(db, txId, tagNames);
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
  /** Flip status pending → effective. Returns null if the id does not exist. */
  confirm: (id: string) => Promise<RawTransactionView | null>;
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
};

export const transactionsRepo = (db: Db): TransactionsRepo => ({
  getById: (id) => fetchTx(db, id),

  confirm: async (id) => {
    await db
      .update(transactions)
      .set({ status: TransactionStatus.enum.effective })
      .where(sql`${transactions.id} = ${id} AND ${transactions.status} = ${TransactionStatus.enum.pending}`);
    return fetchTx(db, id);
  },

  findAllCorrelatedToCard: async (cardId, accountId) => {
    const rows = await db.all<Record<string, unknown>>(fullTxSelect(correlatedToCard(cardId, accountId, 't')));
    return rows.map(transactionAdapters.dbToModel);
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

/**
 * The transaction entity's `EntityApplier` — hand-written rather than `versionedTableApplier`
 * because a transaction row has genuine extra mechanics: `insert` conflicts on `idempotency_key`
 * (not `id`); both `insert` and `update` upsert the referenced merchant — never assuming an
 * update's merchant key already has a satisfying `merchants` row, even though no current caller
 * actually changes it on update — and attach/replace the row's `transaction_tags`. Still
 * persistence structure, not business logic — no bill/paid reasoning here. `model` arrives
 * already row-shaped (adaptation happens upstream, before `runEffects` ever sees the batch), so
 * this applier only ever writes the row it's handed, never adapts one.
 *
 * Both `insert` and `update` read the row back after writing so a flow's idempotency-aware
 * `response` can reflect the actually-persisted, display-joined view (account/category names, the
 * tag rows that actually matched by name) without a second read of its own.
 */
export const transactionApplier: EntityApplier = {
  insert: async (tx, model) => {
    const entity = model as TransactionRowEntity;

    if (entity.merchantKey) {
      await tx.insert(merchants).values({ key: entity.merchantKey }).onConflictDoNothing();
    }

    const result = await tx
      .insert(transactions)
      .values({
        id: entity.id,
        description: entity.description,
        amount: entity.amount,
        type: entity.type,
        status: entity.status,
        date: entity.date,
        currency: entity.currency,
        source: entity.source,
        idempotencyKey: entity.idempotencyKey,
        classificationMethod: entity.classificationMethod,
        confidence: entity.confidence,
        rawInput: entity.rawInput,
        note: entity.note,
        fromAccountId: entity.fromAccountId,
        toAccountId: entity.toAccountId,
        creditCardId: entity.creditCardId,
        billId: entity.billId,
        categoryId: entity.categoryId,
        subcategoryId: entity.subcategoryId,
        merchantKey: entity.merchantKey,
        version: entity.version,
      })
      .onConflictDoNothing({ target: transactions.idempotencyKey });

    const applied = (result.rowsAffected ?? 0) > 0;
    if (applied && entity.tagNames.length > 0) await attachTags(tx, entity.id, entity.tagNames);

    // Duplicate: this entity.id was never inserted — the existing row (by idempotency key) is
    // what's actually persisted, and what an idempotency-aware flow's response must reflect.
    const view = applied ? await fetchTx(tx, entity.id) : await fetchTxByIdempotencyKey(tx, entity.idempotencyKey);
    return { applied, read: expectPresent(view, rowNotFoundAfterWrite('transactions', 'write')) };
  },

  update: async (tx, model) => {
    const entity = model as TransactionRowEntity & { id: string; version: number };

    if (entity.merchantKey) {
      await tx.insert(merchants).values({ key: entity.merchantKey }).onConflictDoNothing();
    }

    const result = await tx
      .update(transactions)
      .set({
        description: entity.description,
        amount: entity.amount,
        type: entity.type,
        status: entity.status,
        date: entity.date,
        currency: entity.currency,
        classificationMethod: entity.classificationMethod,
        confidence: entity.confidence,
        rawInput: entity.rawInput,
        note: entity.note,
        fromAccountId: entity.fromAccountId,
        toAccountId: entity.toAccountId,
        creditCardId: entity.creditCardId,
        billId: entity.billId,
        categoryId: entity.categoryId,
        subcategoryId: entity.subcategoryId,
        merchantKey: entity.merchantKey,
        version: entity.version + 1,
      })
      .where(and(eq(transactions.id, entity.id), eq(transactions.version, entity.version)));

    const applied = (result.rowsAffected ?? 0) > 0;
    if (!applied) return { applied: false };

    await replaceTags(tx, entity.id, entity.tagNames);
    const view = await fetchTx(tx, entity.id);
    return { applied: true, read: expectPresent(view, rowNotFoundAfterWrite('transactions', 'update')) };
  },

  // transaction_tags rows cascade on delete (schema.ts: onDelete: 'cascade') — no explicit tag
  // cleanup needed here, unlike insert/update.
  delete: async (tx, id, version) => {
    const result = await tx.delete(transactions).where(and(eq(transactions.id, id), eq(transactions.version, version)));
    return { applied: (result.rowsAffected ?? 0) > 0 };
  },
};
