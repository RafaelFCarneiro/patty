import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp, type AppContext } from '../app-builder.js';

/**
 * Every table is classified here on purpose, so a new one is a failing test until someone decides what it is to
 * tenancy (docs/architecture.md § Tenancy). An infrastructure table carries no domain data and no owner: the reason
 * it is exempt from "every owned table has user_id and a scoped repo" is written next to it, never assumed.
 */
const OWNED = [
  'accounts',
  'credit_cards',
  'bills',
  'transactions',
  'tags',
  'budgets',
  'recurring_rules',
  'user_settings',
  'transaction_tags',
];
const SHARED_DEFAULT = ['categories', 'merchant_category', 'dashboards'];
const SHARED_REFERENCE = ['merchants', 'currencies', 'currency_rates', 'settings'];
const IDENTITY = ['users', 'invites', 'sessions', 'access_tokens', 'setup_codes', 'client_grants'];
const INFRASTRUCTURE: Record<string, string> = {
  change_events:
    'ADR-036: entity tags between processes, never data; read and written only by diplomat/db/change-events.ts ' +
    'and the composition root’s relay and appending bus — no Deps repo, no applier, not in Tenancy',
};
/** Not application tables: the migrator's journal and the full-text index's shadow tables. */
const ENGINE_TABLES = /^(__drizzle_migrations|sqlite_.*|transactions_fts.*)$/;

let tmpDir: string;
let ctx: AppContext;

beforeAll(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), 'patty-table-classification-'));
  ctx = await buildApp({ dbPath: join(tmpDir, 'test.db') });
});

afterAll(() => rmSync(tmpDir, { recursive: true, force: true }));

const sourceFilesUnder = (folder: string): string[] =>
  readdirSync(folder).flatMap((name) => {
    const path = join(folder, name);
    return statSync(path).isDirectory() ? sourceFilesUnder(path) : path.endsWith('.ts') ? [path] : [];
  });

describe('table classification (ADR-033 §5, ADR-036 §1)', () => {
  it('classifies every table exactly once, so a new table cannot join the schema by accident', async () => {
    const tables = (await ctx.db.all<{ name: string }>(sql`SELECT name FROM sqlite_master WHERE type = 'table'`))
      .map(({ name }) => name)
      .filter((name) => !ENGINE_TABLES.test(name))
      .sort();
    const classified = [
      ...OWNED,
      ...SHARED_DEFAULT,
      ...SHARED_REFERENCE,
      ...IDENTITY,
      ...Object.keys(INFRASTRUCTURE),
    ].sort();

    expect(tables).toEqual(classified);
    expect(new Set(classified).size).toBe(classified.length);
  });

  it('gives every owned table a user_id, and the infrastructure table none of the domain’s', async () => {
    const hasUserId = async (table: string): Promise<boolean> =>
      (await ctx.db.all(sql.raw(`SELECT 1 FROM pragma_table_info('${table}') WHERE name = 'user_id'`))).length > 0;
    const owned = await Promise.all(OWNED.filter((table) => table !== 'transaction_tags').map(hasUserId));

    expect(owned.every(Boolean)).toBe(true);
    // `change_events.user_id` only names whose change a row announces: nullable, no foreign key, never filtered by.
    const [column] = await ctx.db.all<{ notnull: number }>(
      sql`SELECT "notnull" FROM pragma_table_info('change_events') WHERE name = 'user_id'`,
    );
    expect(column?.notnull).toBe(0);
    expect(await ctx.db.all(sql`SELECT 1 FROM pragma_foreign_key_list('change_events')`)).toEqual([]);
  });

  it('is touched by no domain code: models, logic, controllers and adapters never name the table', () => {
    const domainFiles = ['models', 'logic', 'controllers', 'adapters'].flatMap((layer) =>
      sourceFilesUnder(join(process.cwd(), 'src', layer)),
    );
    const naming = domainFiles.filter((file) => /change_events|changeEvents\b/.test(readFileSync(file, 'utf8')));

    expect(naming.map((file) => file.replace(process.cwd(), ''))).toEqual([]);
  });
});
