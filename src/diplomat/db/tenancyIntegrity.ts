import type { InValue } from '@libsql/client';
import { sql, type SQL } from 'drizzle-orm';
import { SQLiteSyncDialect } from 'drizzle-orm/sqlite-core';
import * as R from 'remeda';
import { DefaultCategoryId } from './seed/categories.js';
import { z } from 'zod';

export type SqlReader = { execute: (statement: { sql: string; args: InValue[] }) => Promise<{ rows: unknown[] }> };

export const OWNED_TABLES = [
  'accounts',
  'credit_cards',
  'bills',
  'transactions',
  'tags',
  'budgets',
  'recurring_rules',
] as const;

export const SHARED_OR_OWNED_TABLES = ['categories', 'merchant_category', 'dashboards'] as const;

const USER_KEYED_TABLES = ['user_settings'] as const;

const CountRowSchema = z.object({ count: z.coerce.number() });

const KNOWN_USER = sql`user_id IN (SELECT id FROM users)`;

const dialect = new SQLiteSyncDialect();

type Check = readonly [table: string, orphanCondition: SQL];

/** A shared category must be a seeded one: with the owner missing, the backfill would silently share the owner's. */
const SEEDED_CATEGORY_IDS = sql.join(
  DefaultCategoryId.options.map((id) => sql`${id}`),
  sql`, `,
);

const orphanConditionOf = (table: string): SQL =>
  table === 'categories'
    ? sql`(user_id IS NOT NULL AND NOT (${KNOWN_USER})) OR (user_id IS NULL AND id NOT IN (${SEEDED_CATEGORY_IDS}))`
    : sql`user_id IS NOT NULL AND NOT (${KNOWN_USER})`;

const checks: readonly Check[] = [
  ...OWNED_TABLES.map((table): Check => [table, sql`user_id IS NULL OR NOT (${KNOWN_USER})`]),
  ...SHARED_OR_OWNED_TABLES.map((table): Check => [table, orphanConditionOf(table)]),
  ...USER_KEYED_TABLES.map((table): Check => [table, sql`NOT (${KNOWN_USER})`]),
];

const orphanCount = async (db: SqlReader, [table, orphanCondition]: Check): Promise<readonly [string, number]> => {
  const { sql: text, params } = dialect.sqlToQuery(
    sql`SELECT COUNT(*) AS count FROM ${sql.identifier(table)} WHERE ${orphanCondition}`,
  );
  const { rows } = await db.execute({ sql: text, args: params as InValue[] });
  return [table, CountRowSchema.parse(rows[0]).count];
};

export const findRowsWithoutKnownUser = async (db: SqlReader): Promise<Record<string, number>> =>
  R.pipe(
    await Promise.all(checks.map((check) => orphanCount(db, check))),
    R.filter(([, count]) => count > 0),
    R.fromEntries(),
  );

export const tenancyIntegrityMessage = (violations: Record<string, number>): string =>
  'fintrack: refusing to start — after the tenancy migration some rows belong to no known user (' +
  R.pipe(
    Object.entries(violations),
    R.map(([table, count]) => `${table}: ${count}`),
    R.join(', '),
  ) +
  '). The migration was rolled back and the database is unchanged; restore from the .bak file next to it if in doubt.';

/** Throws so the surrounding transaction rolls back. */
export const assertOwnedRowsHaveKnownUsers = async (db: SqlReader): Promise<void> => {
  const violations = await findRowsWithoutKnownUser(db);
  if (Object.keys(violations).length > 0) throw new Error(tenancyIntegrityMessage(violations));
};
