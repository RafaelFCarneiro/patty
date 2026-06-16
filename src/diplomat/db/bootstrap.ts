import { fileURLToPath } from 'node:url'
import { migrate } from 'drizzle-orm/libsql/migrator'
import type { Db } from './driver.js'
import { categories, currencies, merchantCategory, merchants } from './schema.js'

// Resolve the migrations folder relative to this module (../../../drizzle), so it
// works under both `tsx src/...` (dev) and `node dist/...` (prod/npx) regardless of cwd.
const DEFAULT_MIGRATIONS_FOLDER = fileURLToPath(new URL('../../../drizzle', import.meta.url))

// ---------------------------------------------------------------------------
// Seed data
// ---------------------------------------------------------------------------

const CURRENCIES = [
  { code: 'BRL', symbol: 'R$', name: 'Real Brasileiro' },
  { code: 'USD', symbol: '$', name: 'US Dollar' },
] as const satisfies Array<{ code: string; symbol: string; name: string }>

const CATEGORIES = [
  { id: 'cat-alimentacao',     name: 'Alimentação',       kind: 'expense' as const },
  { id: 'cat-transporte',      name: 'Transporte',        kind: 'expense' as const },
  { id: 'cat-moradia',         name: 'Moradia',           kind: 'expense' as const },
  { id: 'cat-contas-servicos', name: 'Contas & Serviços', kind: 'expense' as const },
  { id: 'cat-saude',           name: 'Saúde',             kind: 'expense' as const },
  { id: 'cat-educacao',        name: 'Educação',          kind: 'expense' as const },
  { id: 'cat-lazer',           name: 'Lazer',             kind: 'expense' as const },
  { id: 'cat-compras',         name: 'Compras',           kind: 'expense' as const },
  { id: 'cat-assinaturas',     name: 'Assinaturas',       kind: 'expense' as const },
  { id: 'cat-viagem',          name: 'Viagem',            kind: 'expense' as const },
  { id: 'cat-impostos',        name: 'Impostos & Taxas',  kind: 'expense' as const },
  { id: 'cat-salario',         name: 'Salário',           kind: 'income'  as const },
  { id: 'cat-renda-extra',     name: 'Renda Extra',       kind: 'income'  as const },
  { id: 'cat-investimentos',   name: 'Investimentos',     kind: 'both'    as const },
  { id: 'cat-outros',          name: 'Outros',            kind: 'both'    as const },
]

/** Weight 3 ≈ confidence 0.8 — matches the prior Neo4j graph seed. */
const MERCHANT_RULES: Array<{ key: string; categoryId: string }> = [
  { key: 'uber',           categoryId: 'cat-transporte' },
  { key: '99',             categoryId: 'cat-transporte' },
  { key: 'posto',          categoryId: 'cat-transporte' },
  { key: 'estacionamento', categoryId: 'cat-transporte' },
  { key: 'ifood',          categoryId: 'cat-alimentacao' },
  { key: 'rappi',          categoryId: 'cat-alimentacao' },
  { key: 'supermercado',   categoryId: 'cat-alimentacao' },
  { key: 'mercado',        categoryId: 'cat-alimentacao' },
  { key: 'padaria',        categoryId: 'cat-alimentacao' },
  { key: 'restaurante',    categoryId: 'cat-alimentacao' },
  { key: 'netflix',        categoryId: 'cat-assinaturas' },
  { key: 'spotify',        categoryId: 'cat-assinaturas' },
  { key: 'amazon prime',   categoryId: 'cat-assinaturas' },
  { key: 'disney',         categoryId: 'cat-assinaturas' },
  { key: 'amazon',         categoryId: 'cat-compras' },
  { key: 'mercado livre',  categoryId: 'cat-compras' },
  { key: 'shopee',         categoryId: 'cat-compras' },
  { key: 'magalu',         categoryId: 'cat-compras' },
  { key: 'farmacia',       categoryId: 'cat-saude' },
  { key: 'drogaria',       categoryId: 'cat-saude' },
  { key: 'smart fit',      categoryId: 'cat-saude' },
  { key: 'vivo',           categoryId: 'cat-contas-servicos' },
  { key: 'claro',          categoryId: 'cat-contas-servicos' },
  { key: 'tim',            categoryId: 'cat-contas-servicos' },
  { key: 'enel',           categoryId: 'cat-contas-servicos' },
  { key: 'sabesp',         categoryId: 'cat-contas-servicos' },
  { key: 'aluguel',        categoryId: 'cat-moradia' },
  { key: 'condominio',     categoryId: 'cat-moradia' },
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
      merchantKey: key, categoryId, weight: 3, origin: 'rule' as const, lastSeen: currentYear,
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
