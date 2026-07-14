import { and, eq, inArray, sql, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import * as transactionAdapters from '../../../adapters/transactions.js';
import type { TransactionRowEntity } from '../../../adapters/transactions.js';
import { expectPresent, rowNotFoundAfterWrite } from '../present.js';
import { SortDirection, type CursorKey } from '../../../models/page.js';
import {
  TransactionStatus,
  TransactionType,
  type CreateTxResult,
  type ResolvedSearchRefs,
  type SearchTransactions,
  type Transaction,
  type RawTransactionView,
  type TransactionPatch,
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
import type { EntityApplier, Tx } from '../unitOfWork.js';

// search_transactions' includeTotal COUNT(*) row — decoded like every other SQL row (ADR
// "decode at the boundary" invariant), not trusted on the strength of a type parameter alone.
// Local to this one query (unlike SummaryRowSchema/AggregateDbRowSchema, whose row shapes are
// genuinely reused in logic/summary.ts and logic/aggregate.ts), so it stays here rather than
// being exported as a wire/db "storage contract" with no second consumer.
const SearchCountRowSchema = z.object({ count: z.number().int() });

// `Db | Tx`: every helper below also runs inside `transactionApplier`'s unit-of-work transaction
// (ADR-021), so each accepts either the top-level `Db` handle or the `Tx` a `db.transaction`
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
 * The transaction entity's `EntityApplier` (ADR-021) — hand-written rather than
 * `versionedTableApplier` (unlike `accounts.ts`'s `accountApplier`) because a transaction row's
 * storage shape has genuine extra mechanics beyond a plain `id`/`version` table: `insert` conflicts
 * on `idempotency_key` (not `id`); both `insert` and `update` upsert the referenced merchant — the
 * applier never assumes an update's merchant key already has a satisfying `merchants` row, even
 * though no current caller actually changes it on update — and attach/replace the row's
 * `transaction_tags`. This is still *persistence structure*, not business
 * logic — no bill/paid reasoning, exactly the repo's own former `create`/`update` mechanics,
 * relocated here so the domain (`controllers/account/transaction.ts`,
 * `controllers/account/transfer.ts`) can describe a transaction write as a `Persistable` instead of
 * calling this repo directly. Registered under `models/transaction.ts`'s `TRANSACTION_ENTITY_TAG`
 * at the composition root (`main.ts`). `model` arrives already row-shaped
 * (`adapters/transactions.ts`'s `entityToDb`, run via `outcomeToDb` before `unitOfWork` ever sees
 * the batch) — this applier only ever writes the row it's handed, never adapts one.
 *
 * Both `insert` and `update` read the row back after writing (`fetchTx`/`fetchTxByIdempotencyKey`)
 * so a flow's idempotency-aware `response` can reflect the actually-persisted, display-joined view
 * (account/category names, the tag rows that actually matched by name) without a second read of
 * its own — mirroring exactly what the pre-ADR-021 repo's own `create`/`update` returned.
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
