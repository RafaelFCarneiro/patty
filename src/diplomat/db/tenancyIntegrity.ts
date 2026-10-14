import { z } from 'zod';

/** What the post-migration check needs of a connection: run one statement, read its rows. A libsql `Transaction`
 *  satisfies it, so the check runs inside the very transaction that applied the migration. */
export type SqlReader = { execute: (sql: string) => Promise<{ rows: unknown[] }> };

/** Tables whose every row belongs to a user (ADR-033 §5). `user_id` is NOT NULL on each. */
export const OWNED_TABLES = [
  'accounts',
  'credit_cards',
  'bills',
  'transactions',
  'tags',
  'budgets',
  'recurring_rules',
] as const;

/** Tables where a null `user_id` means "shared default" — but a non-null one must still name a real user. */
export const SHARED_OR_OWNED_TABLES = ['categories', 'merchant_category', 'dashboards'] as const;

/** Per-user tables keyed by `user_id` alone. */
const USER_KEYED_TABLES = ['user_settings'] as const;

const CountRowSchema = z.object({ count: z.coerce.number() });

const KNOWN_USER = 'user_id IN (SELECT id FROM users)';

const orphanCount = async (db: SqlReader, table: string, orphanCondition: string): Promise<number> => {
  const { rows } = await db.execute(`SELECT COUNT(*) AS count FROM ${table} WHERE ${orphanCondition}`);
  return CountRowSchema.parse(rows[0]).count;
};

/** Table → how many rows have no (or an unknown) owner. Only tables with a violation are listed. */
export const findRowsWithoutKnownUser = async (db: SqlReader): Promise<Record<string, number>> => {
  const checks = [
    ...OWNED_TABLES.map((table) => [table, `user_id IS NULL OR NOT (${KNOWN_USER})`] as const),
    ...SHARED_OR_OWNED_TABLES.map((table) => [table, `user_id IS NOT NULL AND NOT (${KNOWN_USER})`] as const),
    ...USER_KEYED_TABLES.map((table) => [table, `NOT (${KNOWN_USER})`] as const),
  ];
  const counts: Record<string, number> = {};
  for (const [table, condition] of checks) {
    const count = await orphanCount(db, table, condition);
    if (count > 0) counts[table] = count;
  }
  return counts;
};

export const tenancyIntegrityMessage = (violations: Record<string, number>): string =>
  'fintrack: refusing to start — after the tenancy migration some rows belong to no known user (' +
  Object.entries(violations)
    .map(([table, count]) => `${table}: ${count}`)
    .join(', ') +
  '). The migration was rolled back and the database is unchanged; restore from the .bak file next to it if in doubt.';

/** ADR-033 §7: no user-owned row may have a null or unknown `user_id`. Throws (so the surrounding transaction rolls
 *  back) rather than returning, because the only safe response to a violation is to write nothing more. */
export const assertOwnedRowsHaveKnownUsers = async (db: SqlReader): Promise<void> => {
  const violations = await findRowsWithoutKnownUser(db);
  if (Object.keys(violations).length > 0) throw new Error(tenancyIntegrityMessage(violations));
};
