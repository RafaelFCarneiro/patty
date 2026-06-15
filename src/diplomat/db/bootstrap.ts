import type { Database } from 'libsql'

// ---------------------------------------------------------------------------
// DDL
// ---------------------------------------------------------------------------

const DDL = `
  CREATE TABLE IF NOT EXISTS currencies (
    code   TEXT PRIMARY KEY,
    symbol TEXT NOT NULL,
    name   TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS accounts (
    id              TEXT PRIMARY KEY,
    name            TEXT NOT NULL,
    type            TEXT NOT NULL CHECK(type IN ('checking','savings','wallet','investment')),
    initial_balance REAL NOT NULL DEFAULT 0,
    currency        TEXT NOT NULL REFERENCES currencies(code)
  );

  CREATE TABLE IF NOT EXISTS credit_cards (
    id           TEXT PRIMARY KEY,
    name         TEXT NOT NULL,
    closing_day  INTEGER NOT NULL,
    due_day      INTEGER NOT NULL,
    limit_amount REAL,
    currency     TEXT NOT NULL REFERENCES currencies(code)
  );

  CREATE TABLE IF NOT EXISTS categories (
    id        TEXT PRIMARY KEY,
    name      TEXT NOT NULL,
    kind      TEXT NOT NULL CHECK(kind IN ('expense','income','both')),
    parent_id TEXT REFERENCES categories(id)
  );

  CREATE TABLE IF NOT EXISTS merchants (
    key TEXT PRIMARY KEY
  );

  CREATE TABLE IF NOT EXISTS merchant_category (
    merchant_key  TEXT NOT NULL REFERENCES merchants(key),
    category_id   TEXT NOT NULL REFERENCES categories(id),
    weight        REAL NOT NULL DEFAULT 1,
    origin        TEXT NOT NULL CHECK(origin IN ('rule','graph')),
    last_seen     INTEGER,
    PRIMARY KEY (merchant_key, category_id)
  );

  CREATE TABLE IF NOT EXISTS tags (
    id   TEXT PRIMARY KEY,
    name TEXT NOT NULL UNIQUE
  );

  CREATE TABLE IF NOT EXISTS bills (
    id           TEXT PRIMARY KEY,
    credit_card_id TEXT NOT NULL REFERENCES credit_cards(id),
    month        INTEGER NOT NULL,
    year         INTEGER NOT NULL,
    close_date   TEXT NOT NULL,
    due_date     TEXT NOT NULL,
    status       TEXT NOT NULL CHECK(status IN ('open','closed','paid')),
    UNIQUE(credit_card_id, month, year)
  );

  CREATE TABLE IF NOT EXISTS transactions (
    id                    TEXT PRIMARY KEY,
    description           TEXT NOT NULL,
    amount                REAL NOT NULL,
    type                  TEXT NOT NULL CHECK(type IN ('income','expense','transfer')),
    date                  TEXT NOT NULL,
    currency              TEXT NOT NULL REFERENCES currencies(code),
    source                TEXT NOT NULL,
    idempotency_key       TEXT NOT NULL UNIQUE,
    classification_method TEXT NOT NULL,
    confidence            REAL NOT NULL,
    raw_input             TEXT,
    from_account_id       TEXT REFERENCES accounts(id),
    to_account_id         TEXT REFERENCES accounts(id),
    credit_card_id        TEXT REFERENCES credit_cards(id),
    category_id           TEXT REFERENCES categories(id),
    subcategory_id        TEXT REFERENCES categories(id),
    merchant_key          TEXT REFERENCES merchants(key),
    bill_id               TEXT REFERENCES bills(id),
    -- sub-category requires a parent category
    CHECK(subcategory_id IS NULL OR category_id IS NOT NULL)
  );

  CREATE TABLE IF NOT EXISTS transaction_tags (
    transaction_id TEXT NOT NULL REFERENCES transactions(id) ON DELETE CASCADE,
    tag_id         TEXT NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
    PRIMARY KEY (transaction_id, tag_id)
  );

  CREATE TABLE IF NOT EXISTS recurring_rules (
    id           TEXT PRIMARY KEY,
    description  TEXT NOT NULL,
    amount       REAL NOT NULL,
    type         TEXT NOT NULL CHECK(type IN ('income','expense')),
    period       TEXT NOT NULL CHECK(period IN ('monthly','weekly')),
    next_due     TEXT NOT NULL,
    currency     TEXT NOT NULL REFERENCES currencies(code),
    account_id   TEXT REFERENCES accounts(id),
    category_id  TEXT REFERENCES categories(id)
  );

  -- Indexes for the hot query paths
  CREATE INDEX IF NOT EXISTS idx_transactions_date           ON transactions(date);
  CREATE INDEX IF NOT EXISTS idx_transactions_from_account   ON transactions(from_account_id);
  CREATE INDEX IF NOT EXISTS idx_transactions_to_account     ON transactions(to_account_id);
  CREATE INDEX IF NOT EXISTS idx_transactions_category       ON transactions(category_id);
  CREATE INDEX IF NOT EXISTS idx_merchant_category_merchant  ON merchant_category(merchant_key);

  -- FTS5 virtual table for search_transactions (libSQL bundles FTS5)
  CREATE VIRTUAL TABLE IF NOT EXISTS transactions_fts
    USING fts5(description, content='transactions', content_rowid='rowid');

  -- Keep FTS5 in sync
  CREATE TRIGGER IF NOT EXISTS transactions_fts_insert
    AFTER INSERT ON transactions BEGIN
      INSERT INTO transactions_fts(rowid, description) VALUES (new.rowid, new.description);
    END;

  CREATE TRIGGER IF NOT EXISTS transactions_fts_update
    AFTER UPDATE OF description ON transactions BEGIN
      INSERT INTO transactions_fts(transactions_fts, rowid, description)
        VALUES ('delete', old.rowid, old.description);
      INSERT INTO transactions_fts(rowid, description) VALUES (new.rowid, new.description);
    END;

  CREATE TRIGGER IF NOT EXISTS transactions_fts_delete
    AFTER DELETE ON transactions BEGIN
      INSERT INTO transactions_fts(transactions_fts, rowid, description)
        VALUES ('delete', old.rowid, old.description);
    END;
`

// ---------------------------------------------------------------------------
// Seed data
// ---------------------------------------------------------------------------

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

/** Weight 3 ≈ confidence 0.8 — matches the seeded Neo4j graph edges. */
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

const seedCurrencies = (db: Database): void => {
  const stmt = db.prepare(
    'INSERT OR IGNORE INTO currencies (code, symbol, name) VALUES (?, ?, ?)',
  )
  for (const { code, symbol, name } of CURRENCIES) {
    stmt.run(code, symbol, name)
  }
}

const seedCategories = (db: Database): void => {
  const stmt = db.prepare(
    'INSERT OR IGNORE INTO categories (id, name, kind) VALUES (?, ?, ?)',
  )
  for (const { id, name, kind } of CATEGORIES) {
    stmt.run(id, name, kind)
  }
}

const seedMerchantRules = (db: Database): void => {
  const merchantStmt = db.prepare('INSERT OR IGNORE INTO merchants (key) VALUES (?)')
  const ruleStmt = db.prepare(
    `INSERT OR IGNORE INTO merchant_category (merchant_key, category_id, weight, origin, last_seen)
     VALUES (?, ?, 3, 'rule', strftime('%Y', 'now'))`,
  )
  for (const { key, categoryId } of MERCHANT_RULES) {
    merchantStmt.run(key)
    ruleStmt.run(key, categoryId)
  }
}

/** Idempotent: safe to call on every boot. */
export const bootstrap = (db: Database): void => {
  db.exec(DDL)
  seedCurrencies(db)
  seedCategories(db)
  seedMerchantRules(db)
}
