import { and, eq, isNull, or, type SQL, sql } from 'drizzle-orm';
import type { AnySQLiteColumn } from 'drizzle-orm/sqlite-core';
import type { Db } from '../driver.js';

export type RepoScope = { db: Db; userId: string };

/**
 * Where a query says whose rows. `ownedBy`: the user's own. `visibleTo`: own plus the shared defaults (user_id NULL),
 * for reads of categories, merchant edges and dashboards only.
 */
const column = (alias: string, name: string): SQL => sql.raw(alias ? `${alias}.${name}` : name);

export const ownedBy = (userId: string, alias = ''): SQL => sql`${column(alias, 'user_id')} = ${userId}`;

export const visibleTo = (userId: string, alias = ''): SQL =>
  sql`(${column(alias, 'user_id')} = ${userId} OR ${column(alias, 'user_id')} IS NULL)`;

export const ownedRows = (userIdColumn: AnySQLiteColumn, userId: string): SQL => eq(userIdColumn, userId);

export const visibleRows = (userIdColumn: AnySQLiteColumn, userId: string): SQL =>
  or(eq(userIdColumn, userId), isNull(userIdColumn)) as SQL;

export const ownedWhere = (userIdColumn: AnySQLiteColumn, userId: string, where?: SQL): SQL =>
  (where ? and(ownedRows(userIdColumn, userId), where) : ownedRows(userIdColumn, userId)) as SQL;

export const visibleWhere = (userIdColumn: AnySQLiteColumn, userId: string, where?: SQL): SQL =>
  (where ? and(visibleRows(userIdColumn, userId), where) : visibleRows(userIdColumn, userId)) as SQL;
