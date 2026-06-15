import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import { categories, currencies, merchantCategory, merchants } from './schema.js'
import type * as schema from './schema.js'

// ---------------------------------------------------------------------------
// Seed data
// ---------------------------------------------------------------------------

const CURRENCIES = [
  { code: 'BRL', symbol: 'R$', name: 'Real Brasileiro' },
  { code: 'USD', symbol: '$', name: 'US Dollar' },
] as const

const CATEGORIES = [
  { id: 'cat-alimentacao',    name: 'Alimentação',       kind: 'expense' },
  { id: 'cat-transporte',     name: 'Transporte',        kind: 'expense' },
  { id: 'cat-moradia',        name: 'Moradia',           kind: 'expense' },
  { id: 'cat-contas-servicos',name: 'Contas & Serviços', kind: 'expense' },
  { id: 'cat-saude',          name: 'Saúde',             kind: 'expense' },
  { id: 'cat-educacao',       name: 'Educação',          kind: 'expense' },
  { id: 'cat-lazer',          name: 'Lazer',             kind: 'expense' },
  { id: 'cat-compras',        name: 'Compras',           kind: 'expense' },
  { id: 'cat-assinaturas',    name: 'Assinaturas',       kind: 'expense' },
  { id: 'cat-viagem',         name: 'Viagem',            kind: 'expense' },
  { id: 'cat-impostos',       name: 'Impostos & Taxas',  kind: 'expense' },
  { id: 'cat-salario',        name: 'Salário',           kind: 'income'  },
  { id: 'cat-renda-extra',    name: 'Renda Extra',       kind: 'income'  },
  { id: 'cat-investimentos',  name: 'Investimentos',     kind: 'both'    },
  { id: 'cat-outros',         name: 'Outros',            kind: 'both'    },
] as const satisfies Array<{ id: string; name: string; kind: 'expense' | 'income' | 'both' }>

/** Weight 3 ≈ confidence 0.8 — matches the prior Neo4j graph seed. */
const MERCHANT_RULES: Array<{ key: string; categoryId: string }> = [
  { key: 'uber',          categoryId: 'cat-transporte' },
  { key: '99',            categoryId: 'cat-transporte' },
  { key: 'posto',         categoryId: 'cat-transporte' },
  { key: 'estacionamento',categoryId: 'cat-transporte' },
  { key: 'ifood',         categoryId: 'cat-alimentacao' },
  { key: 'rappi',         categoryId: 'cat-alimentacao' },
  { key: 'supermercado',  categoryId: 'cat-alimentacao' },
  { key: 'mercado',       categoryId: 'cat-alimentacao' },
  { key: 'padaria',       categoryId: 'cat-alimentacao' },
  { key: 'restaurante',   categoryId: 'cat-alimentacao' },
  { key: 'netflix',       categoryId: 'cat-assinaturas' },
  { key: 'spotify',       categoryId: 'cat-assinaturas' },
  { key: 'amazon prime',  categoryId: 'cat-assinaturas' },
  { key: 'disney',        categoryId: 'cat-assinaturas' },
  { key: 'amazon',        categoryId: 'cat-compras' },
  { key: 'mercado livre', categoryId: 'cat-compras' },
  { key: 'shopee',        categoryId: 'cat-compras' },
  { key: 'magalu',        categoryId: 'cat-compras' },
  { key: 'farmacia',      categoryId: 'cat-saude' },
  { key: 'drogaria',      categoryId: 'cat-saude' },
  { key: 'smart fit',     categoryId: 'cat-saude' },
  { key: 'vivo',          categoryId: 'cat-contas-servicos' },
  { key: 'claro',         categoryId: 'cat-contas-servicos' },
  { key: 'tim',           categoryId: 'cat-contas-servicos' },
  { key: 'enel',          categoryId: 'cat-contas-servicos' },
  { key: 'sabesp',        categoryId: 'cat-contas-servicos' },
  { key: 'aluguel',       categoryId: 'cat-moradia' },
  { key: 'condominio',    categoryId: 'cat-moradia' },
]

// ---------------------------------------------------------------------------
// Seed helpers
// ---------------------------------------------------------------------------

type Db = BetterSQLite3Database<typeof schema>

const seedCurrencies = (db: Db): void => {
  db.insert(currencies).values([...CURRENCIES]).onConflictDoNothing().run()
}

const seedCategories = (db: Db): void => {
  db.insert(categories).values(CATEGORIES).onConflictDoNothing().run()
}

const seedMerchantRules = (db: Db): void => {
  const currentYear = new Date().getFullYear()
  for (const { key, categoryId } of MERCHANT_RULES) {
    db.insert(merchants).values({ key }).onConflictDoNothing().run()
    db.insert(merchantCategory)
      .values({ merchantKey: key, categoryId, weight: 3, origin: 'rule', lastSeen: currentYear })
      .onConflictDoNothing()
      .run()
  }
}

// ---------------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------------

/** Idempotent: applies pending migrations then upserts seed data. Safe on every boot. */
export const bootstrap = (db: Db, migrationsFolder = './drizzle'): void => {
  migrate(db, { migrationsFolder })
  seedCurrencies(db)
  seedCategories(db)
  seedMerchantRules(db)
}
