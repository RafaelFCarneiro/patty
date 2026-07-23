import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { migrate } from 'drizzle-orm/libsql/migrator';
import * as R from 'remeda';
import { ClassificationMethod } from '../../models/transaction.js';
import { normalizeMerchant } from '../../logic/merchant.js';
import type { Db } from './driver.js';
import { categories, currencies, dashboards, merchantCategory, merchants } from './schema.js';
import { CURRENCIES } from './seed/currencies.js';
import { CATEGORIES } from './seed/categories.js';
import { DEFAULT_DASHBOARD_HTML, DEFAULT_DASHBOARD_NAME } from './seed/dashboards.js';
import { DEFAULT_MERCHANT_RULES } from './seed/merchantRules.js';

// Resolve the migrations folder relative to this module (../../../drizzle), so it
// works under both `tsx src/...` (dev) and `node dist/...` (prod/npx) regardless of cwd.
const DEFAULT_MIGRATIONS_FOLDER = fileURLToPath(new URL('../../../drizzle', import.meta.url));

// ---------------------------------------------------------------------------
// Seed helpers
// ---------------------------------------------------------------------------

/** Seeded-rule weight (≈ 0.8 confidence). Named so the value isn't a bare literal. */
const SEED_RULE_WEIGHT = 3;

const seedRules = (): ReadonlyArray<{ key: string; categoryId: string }> =>
  R.pipe(
    DEFAULT_MERCHANT_RULES,
    R.map(({ key, category }) => ({ key: normalizeMerchant(key), categoryId: category })),
    R.filter(({ key }) => key.length > 0),
    R.uniqueBy(({ key, categoryId }) => `${key} ${categoryId}`),
  );

const seedCurrencies = async (db: Db): Promise<void> => {
  await db
    .insert(currencies)
    .values([...CURRENCIES])
    .onConflictDoNothing();
};

const seedCategories = async (db: Db): Promise<void> => {
  await db
    .insert(categories)
    .values([...CATEGORIES])
    .onConflictDoNothing();
};

// Seeded once (onConflictDoNothing on the `name` UNIQUE constraint); a later save_dashboard
// upsert overrides it and survives future boots — bootstrap never re-seeds over a dashboard that
// already exists. The minted id is discarded on that conflict path, same as any other insert.
const seedDashboards = async (db: Db): Promise<void> => {
  await db
    .insert(dashboards)
    .values({
      id: randomUUID(),
      name: DEFAULT_DASHBOARD_NAME,
      html: DEFAULT_DASHBOARD_HTML,
      updatedAt: new Date().toISOString(),
    })
    .onConflictDoNothing();
};

const seedMerchantRules = async (db: Db): Promise<void> => {
  const currentYear = new Date().getFullYear();
  const rules = seedRules();
  const distinctKeys = [...new Set(rules.map(({ key }) => key))];

  await db
    .insert(merchants)
    .values(distinctKeys.map((key) => ({ key })))
    .onConflictDoNothing();
  await db
    .insert(merchantCategory)
    .values(
      rules.map(({ key, categoryId }) => ({
        merchantKey: key,
        categoryId,
        weight: SEED_RULE_WEIGHT,
        origin: ClassificationMethod.enum.rule,
        lastSeen: currentYear,
      })),
    )
    .onConflictDoNothing();
};

// ---------------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------------

/** Idempotent: applies pending migrations then upserts seed data. Safe on every boot. */
export const bootstrap = async (db: Db, migrationsFolder = DEFAULT_MIGRATIONS_FOLDER): Promise<void> => {
  await migrate(db, { migrationsFolder });
  await seedCurrencies(db);
  await seedCategories(db);
  await seedMerchantRules(db);
  await seedDashboards(db);
};
