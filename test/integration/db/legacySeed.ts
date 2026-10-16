import { sql } from 'drizzle-orm';
import type { Db } from '../../../src/diplomat/db/driver.js';
import { CATEGORIES } from '../../../src/diplomat/db/seed/categories.js';
import { CURRENCIES } from '../../../src/diplomat/db/seed/currencies.js';
import { DEFAULT_MERCHANT_RULES } from '../../../src/diplomat/db/seed/merchantRules.js';
import { listDefaultDashboardFiles } from '../../../src/diplomat/db/repos/dashboards.js';
import { normalizeMerchant } from '../../../src/logic/merchant.js';

/** What bootstrap seeds, written against the pre-tenancy schema (no user_id): the seed code itself targets the
 *  current one, so a database as the previous release left it is seeded here by hand. */
export const seedAsBefore = async (db: Db): Promise<void> => {
  for (const c of CURRENCIES)
    await db.run(
      sql`INSERT OR IGNORE INTO currencies (code, symbol, name, decimals) VALUES (${c.code}, ${c.symbol}, ${c.name}, ${c.decimals})`,
    );
  for (const c of CATEGORIES)
    await db.run(
      sql`INSERT OR IGNORE INTO categories (id, name, kind, names) VALUES (${c.id}, ${c.name}, ${c.kind}, ${c.names})`,
    );
  const rules = DEFAULT_MERCHANT_RULES.map(({ key, category }) => ({ key: normalizeMerchant(key), category })).filter(
    ({ key }) => key.length > 0,
  );
  for (const key of new Set(rules.map((r) => r.key)))
    await db.run(sql`INSERT OR IGNORE INTO merchants (key) VALUES (${key})`);
  for (const { key, category } of rules)
    await db.run(
      sql`INSERT OR IGNORE INTO merchant_category (merchant_key, category_id, weight, origin, last_seen) VALUES (${key}, ${category}, 3, 'rule', 2026)`,
    );
  for (const file of await listDefaultDashboardFiles())
    await db.run(
      sql`INSERT OR IGNORE INTO dashboards (id, name, html, source, path, updated_at, version) VALUES (${`d-${file}`}, ${file.replace(/\.html$/, '')}, NULL, 'file', ${file}, '2026-01-01T00:00:00Z', 0)`,
    );
};
