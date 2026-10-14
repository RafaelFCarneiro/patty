import { and, eq, isNull, or, type SQL, sql } from 'drizzle-orm';
import type { AnySQLiteColumn } from 'drizzle-orm/sqlite-core';

/**
 * Tenancy predicates (ADR-033 §5) — the one place a query says "whose rows". Every repo is built for one user
 * (`xRepo(db, userId)`), so a controller cannot ask for another's data or forget to scope a query: it is handed repos
 * that are already bound.
 *
 *  - `ownedBy`: rows that are the user's own (every owned table — accounts, transactions, tags, …).
 *  - `visibleTo`: the user's own rows plus the shared defaults (`user_id IS NULL` — the seeded categories, `rule`
 *    merchant edges, `file` dashboards). Reads of those three tables use it; writes never do (a shared row is not
 *    writable through a scoped runner), which is `ownedBy` in the appliers.
 *
 * Two flavours of each: raw-SQL fragments (qualified by an alias) and drizzle column conditions.
 */
const column = (alias: string, name: string): SQL => sql.raw(alias ? `${alias}.${name}` : name);

export const ownedBy = (userId: string, alias = ''): SQL => sql`${column(alias, 'user_id')} = ${userId}`;

export const visibleTo = (userId: string, alias = ''): SQL =>
  sql`(${column(alias, 'user_id')} = ${userId} OR ${column(alias, 'user_id')} IS NULL)`;

export const ownedRows = (userIdColumn: AnySQLiteColumn, userId: string): SQL => eq(userIdColumn, userId);

export const visibleRows = (userIdColumn: AnySQLiteColumn, userId: string): SQL =>
  or(eq(userIdColumn, userId), isNull(userIdColumn)) as SQL;

/** `where` narrowed to the user's own rows — for the drizzle query builder. */
export const ownedWhere = (userIdColumn: AnySQLiteColumn, userId: string, where?: SQL): SQL =>
  (where ? and(ownedRows(userIdColumn, userId), where) : ownedRows(userIdColumn, userId)) as SQL;

/** `where` narrowed to the user's own rows plus the shared defaults. */
export const visibleWhere = (userIdColumn: AnySQLiteColumn, userId: string, where?: SQL): SQL =>
  (where ? and(visibleRows(userIdColumn, userId), where) : visibleRows(userIdColumn, userId)) as SQL;
