import type { Driver } from 'neo4j-driver'
import { run } from './driver.js'

const CONSTRAINTS = [
  'CREATE CONSTRAINT currency_code IF NOT EXISTS FOR (c:Currency) REQUIRE c.code IS UNIQUE',
  'CREATE CONSTRAINT account_id IF NOT EXISTS FOR (a:Account) REQUIRE a.id IS UNIQUE',
  'CREATE CONSTRAINT category_id IF NOT EXISTS FOR (c:Category) REQUIRE c.id IS UNIQUE',
  'CREATE CONSTRAINT merchant_key IF NOT EXISTS FOR (m:Merchant) REQUIRE m.key IS UNIQUE',
  'CREATE CONSTRAINT tx_id IF NOT EXISTS FOR (t:Transaction) REQUIRE t.id IS UNIQUE',
  'CREATE CONSTRAINT tx_idempotency IF NOT EXISTS FOR (t:Transaction) REQUIRE t.idempotencyKey IS UNIQUE',
  'CREATE CONSTRAINT creditcard_id IF NOT EXISTS FOR (cc:CreditCard) REQUIRE cc.id IS UNIQUE',
  'CREATE CONSTRAINT bill_id IF NOT EXISTS FOR (b:Bill) REQUIRE b.id IS UNIQUE',
  'CREATE CONSTRAINT recurring_id IF NOT EXISTS FOR (r:RecurringRule) REQUIRE r.id IS UNIQUE',
  'CREATE CONSTRAINT tag_id IF NOT EXISTS FOR (t:Tag) REQUIRE t.id IS UNIQUE',
  'CREATE CONSTRAINT tag_name IF NOT EXISTS FOR (t:Tag) REQUIRE t.name IS UNIQUE',
  'CREATE CONSTRAINT subcategory_id IF NOT EXISTS FOR (sc:SubCategory) REQUIRE sc.id IS UNIQUE',
  'CREATE INDEX tx_date IF NOT EXISTS FOR (t:Transaction) ON (t.date)',
]

const CURRENCIES = [
  { code: 'BRL', symbol: 'R$', name: 'Real Brasileiro' },
  { code: 'USD', symbol: '$', name: 'US Dollar' },
]

const CATEGORIES = [
  { id: 'cat-alimentacao', name: 'Alimentação', kind: 'expense' },
  { id: 'cat-transporte', name: 'Transporte', kind: 'expense' },
  { id: 'cat-moradia', name: 'Moradia', kind: 'expense' },
  { id: 'cat-contas-servicos', name: 'Contas & Serviços', kind: 'expense' },
  { id: 'cat-saude', name: 'Saúde', kind: 'expense' },
  { id: 'cat-educacao', name: 'Educação', kind: 'expense' },
  { id: 'cat-lazer', name: 'Lazer', kind: 'expense' },
  { id: 'cat-compras', name: 'Compras', kind: 'expense' },
  { id: 'cat-assinaturas', name: 'Assinaturas', kind: 'expense' },
  { id: 'cat-viagem', name: 'Viagem', kind: 'expense' },
  { id: 'cat-impostos', name: 'Impostos & Taxas', kind: 'expense' },
  { id: 'cat-salario', name: 'Salário', kind: 'income' },
  { id: 'cat-renda-extra', name: 'Renda Extra', kind: 'income' },
  { id: 'cat-investimentos', name: 'Investimentos', kind: 'both' },
  { id: 'cat-outros', name: 'Outros', kind: 'both' },
]

/** Seeded BR merchant rules: key → category. Weight 3 ≈ confidence 0.8. */
const MERCHANT_RULES: Array<{ key: string; categoryId: string }> = [
  { key: 'uber', categoryId: 'cat-transporte' },
  { key: '99', categoryId: 'cat-transporte' },
  { key: 'posto', categoryId: 'cat-transporte' },
  { key: 'estacionamento', categoryId: 'cat-transporte' },
  { key: 'ifood', categoryId: 'cat-alimentacao' },
  { key: 'rappi', categoryId: 'cat-alimentacao' },
  { key: 'supermercado', categoryId: 'cat-alimentacao' },
  { key: 'mercado', categoryId: 'cat-alimentacao' },
  { key: 'padaria', categoryId: 'cat-alimentacao' },
  { key: 'restaurante', categoryId: 'cat-alimentacao' },
  { key: 'netflix', categoryId: 'cat-assinaturas' },
  { key: 'spotify', categoryId: 'cat-assinaturas' },
  { key: 'amazon prime', categoryId: 'cat-assinaturas' },
  { key: 'disney', categoryId: 'cat-assinaturas' },
  { key: 'amazon', categoryId: 'cat-compras' },
  { key: 'mercado livre', categoryId: 'cat-compras' },
  { key: 'shopee', categoryId: 'cat-compras' },
  { key: 'magalu', categoryId: 'cat-compras' },
  { key: 'farmacia', categoryId: 'cat-saude' },
  { key: 'drogaria', categoryId: 'cat-saude' },
  { key: 'smart fit', categoryId: 'cat-saude' },
  { key: 'vivo', categoryId: 'cat-contas-servicos' },
  { key: 'claro', categoryId: 'cat-contas-servicos' },
  { key: 'tim', categoryId: 'cat-contas-servicos' },
  { key: 'enel', categoryId: 'cat-contas-servicos' },
  { key: 'sabesp', categoryId: 'cat-contas-servicos' },
  { key: 'aluguel', categoryId: 'cat-moradia' },
  { key: 'condominio', categoryId: 'cat-moradia' },
]

/** Idempotent: safe to run on every boot. */
export const bootstrap = async (driver: Driver): Promise<void> => {
  for (const c of CONSTRAINTS) await run(driver, c)

  await run(
    driver,
    `UNWIND $currencies AS cur
     MERGE (c:Currency {code: cur.code})
     ON CREATE SET c.symbol = cur.symbol, c.name = cur.name`,
    { currencies: CURRENCIES },
  )

  await run(
    driver,
    `UNWIND $categories AS cat
     MERGE (c:Category {id: cat.id})
     ON CREATE SET c.name = cat.name, c.kind = cat.kind`,
    { categories: CATEGORIES },
  )

  await run(
    driver,
    `UNWIND $rules AS rule
     MERGE (m:Merchant {key: rule.key})
     WITH m, rule
     MATCH (c:Category {id: rule.categoryId})
     MERGE (m)-[u:USUALLY]->(c)
     ON CREATE SET u.weight = 3, u.origin = 'rule', u.lastSeen = date().year`,
    { rules: MERCHANT_RULES },
  )
}
