import { fileURLToPath } from 'node:url'
import { migrate } from 'drizzle-orm/libsql/migrator'
import { CurrencyCode } from '../../models/common.js'
import { CategoryKind } from '../../models/category.js'
import { ClassificationMethod } from '../../models/transaction.js'
import type { Db } from './driver.js'
import { categories, currencies, merchantCategory, merchants } from './schema.js'

// Resolve the migrations folder relative to this module (../../../drizzle), so it
// works under both `tsx src/...` (dev) and `node dist/...` (prod/npx) regardless of cwd.
const DEFAULT_MIGRATIONS_FOLDER = fileURLToPath(new URL('../../../drizzle', import.meta.url))

// ---------------------------------------------------------------------------
// Seed data
// ---------------------------------------------------------------------------

const CURRENCIES = [
  { code: CurrencyCode.enum.BRL, symbol: 'R$', name: 'Real Brasileiro' },
  { code: CurrencyCode.enum.USD, symbol: '$',  name: 'US Dollar' },
] as const satisfies Array<{ code: string; symbol: string; name: string }>

const CATEGORIES = [
  { id: 'cat-food',          name: 'Food',          kind: CategoryKind.enum.expense, i18nKey: 'cat-food' },
  { id: 'cat-transport',     name: 'Transport',     kind: CategoryKind.enum.expense, i18nKey: 'cat-transport' },
  { id: 'cat-housing',       name: 'Housing',       kind: CategoryKind.enum.expense, i18nKey: 'cat-housing' },
  { id: 'cat-utilities',     name: 'Utilities',     kind: CategoryKind.enum.expense, i18nKey: 'cat-utilities' },
  { id: 'cat-health',        name: 'Health',        kind: CategoryKind.enum.expense, i18nKey: 'cat-health' },
  { id: 'cat-education',     name: 'Education',     kind: CategoryKind.enum.expense, i18nKey: 'cat-education' },
  { id: 'cat-leisure',       name: 'Leisure',       kind: CategoryKind.enum.expense, i18nKey: 'cat-leisure' },
  { id: 'cat-shopping',      name: 'Shopping',      kind: CategoryKind.enum.expense, i18nKey: 'cat-shopping' },
  { id: 'cat-subscriptions', name: 'Subscriptions', kind: CategoryKind.enum.expense, i18nKey: 'cat-subscriptions' },
  { id: 'cat-travel',        name: 'Travel',        kind: CategoryKind.enum.expense, i18nKey: 'cat-travel' },
  { id: 'cat-taxes',         name: 'Taxes',         kind: CategoryKind.enum.expense, i18nKey: 'cat-taxes' },
  { id: 'cat-salary',        name: 'Salary',        kind: CategoryKind.enum.income,  i18nKey: 'cat-salary' },
  { id: 'cat-extra-income',  name: 'Extra Income',  kind: CategoryKind.enum.income,  i18nKey: 'cat-extra-income' },
  { id: 'cat-investments',   name: 'Investments',   kind: CategoryKind.enum.both,    i18nKey: 'cat-investments' },
  { id: 'cat-other',         name: 'Other',         kind: CategoryKind.enum.both,    i18nKey: 'cat-other' },
]

/** Weight 3 ≈ confidence 0.8 for seeded merchant rules. */
const MERCHANT_RULES: Array<{ key: string; categoryId: string }> = [
  { key: 'uber',           categoryId: 'cat-transport' },
  { key: 'lyft',           categoryId: 'cat-transport' },
  { key: 'gas',            categoryId: 'cat-transport' },
  { key: 'parking',        categoryId: 'cat-transport' },
  { key: 'restaurant',     categoryId: 'cat-food' },
  { key: 'supermarket',    categoryId: 'cat-food' },
  { key: 'grocery',        categoryId: 'cat-food' },
  { key: 'bakery',         categoryId: 'cat-food' },
  { key: 'netflix',        categoryId: 'cat-subscriptions' },
  { key: 'spotify',        categoryId: 'cat-subscriptions' },
  { key: 'amazon prime',   categoryId: 'cat-subscriptions' },
  { key: 'disney',         categoryId: 'cat-subscriptions' },
  { key: 'amazon',         categoryId: 'cat-shopping' },
  { key: 'walmart',        categoryId: 'cat-shopping' },
  { key: 'target',         categoryId: 'cat-shopping' },
  { key: 'pharmacy',       categoryId: 'cat-health' },
  { key: 'doctor',         categoryId: 'cat-health' },
  { key: 'gym',            categoryId: 'cat-health' },
  { key: 'rent',           categoryId: 'cat-housing' },
  { key: 'electric',       categoryId: 'cat-utilities' },
  { key: 'water',          categoryId: 'cat-utilities' },
  { key: 'internet',       categoryId: 'cat-utilities' },
  { key: 'phone',          categoryId: 'cat-utilities' },
]

// ---------------------------------------------------------------------------
// Seed helpers
// ---------------------------------------------------------------------------

const seedCurrencies = async (db: Db): Promise<void> => {
  await db.insert(currencies).values([...CURRENCIES]).onConflictDoNothing()
}

const seedCategories = async (db: Db): Promise<void> => {
  await db.insert(categories).values(CATEGORIES).onConflictDoNothing()
}

const seedMerchantRules = async (db: Db): Promise<void> => {
  const currentYear = new Date().getFullYear()
  await db.insert(merchants)
    .values(MERCHANT_RULES.map(({ key }) => ({ key })))
    .onConflictDoNothing()
  await db.insert(merchantCategory)
    .values(MERCHANT_RULES.map(({ key, categoryId }) => ({
      merchantKey: key, categoryId, weight: 3, origin: ClassificationMethod.enum.rule, lastSeen: currentYear,
    })))
    .onConflictDoNothing()
}

// ---------------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------------

/** Idempotent: applies pending migrations then upserts seed data. Safe on every boot. */
export const bootstrap = async (db: Db, migrationsFolder = DEFAULT_MIGRATIONS_FOLDER): Promise<void> => {
  await migrate(db, { migrationsFolder })
  await seedCurrencies(db)
  await seedCategories(db)
  await seedMerchantRules(db)
}
