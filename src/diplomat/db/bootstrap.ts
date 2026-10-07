import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { migrate } from 'drizzle-orm/libsql/migrator';
import * as R from 'remeda';
import { DashboardSource } from '../../models/dashboard.js';
import { ClassificationMethod } from '../../models/transaction.js';
import { normalizeMerchant } from '../../logic/merchant.js';
import type { Db } from './driver.js';
import { HTML_FILE_EXTENSION, listDefaultDashboardFiles } from './repos/dashboards.js';
import { categories, currencies, dashboards, merchantCategory, merchants } from './schema.js';
import { migrateWithSafetyCopy } from './safetyCopy.js';
import { CURRENCIES } from './seed/currencies.js';
import { CATEGORIES } from './seed/categories.js';
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

// Reconciles rows to the default dashboard files actually present under ui/dashboards/ (ADR-027
// Phase 2) — every *.html file there becomes a source: 'file' row, named after its own filename,
// on every boot; dropping a new default in that folder needs no code change here. Seeded once per
// name (onConflictDoNothing on the `name` UNIQUE constraint): a later save_dashboard upsert
// detaches that name into a custom, inline row and survives future boots — bootstrap never
// re-seeds over a dashboard that already exists, file-backed or not. The minted id is discarded on
// that conflict path, same as any other insert.
const seedDashboards = async (db: Db): Promise<void> => {
  const files = await listDefaultDashboardFiles();
  if (files.length === 0) return;

  const now = new Date().toISOString();
  await db
    .insert(dashboards)
    .values(
      files.map((filename) => ({
        id: randomUUID(),
        name: filename.slice(0, -HTML_FILE_EXTENSION.length),
        html: null,
        source: DashboardSource.enum.file,
        path: filename,
        updatedAt: now,
      })),
    )
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

/** Idempotent: applies pending migrations (after a safety copy, if one rewrites existing data) then
 *  upserts seed data. Safe on every boot. */
export const bootstrap = async (db: Db, migrationsFolder = DEFAULT_MIGRATIONS_FOLDER): Promise<void> => {
  await migrateWithSafetyCopy(db, migrationsFolder, () => migrate(db, { migrationsFolder }));
  await seedCurrencies(db);
  await seedCategories(db);
  await seedMerchantRules(db);
  await seedDashboards(db);
};
