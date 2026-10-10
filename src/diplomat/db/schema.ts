import {
  check,
  foreignKey,
  index,
  integer,
  primaryKey,
  real,
  sqliteTable,
  text,
  uniqueIndex,
  type AnySQLiteColumn,
} from 'drizzle-orm/sqlite-core';
import { sql } from 'drizzle-orm';
import { type Scope, UserRole } from '../../models/auth.js';
import { BudgetPeriod } from '../../models/budget.js';
import { DashboardSource } from '../../models/dashboard.js';
import { Locale, LocaleSource } from '../../models/locale.js';
import { RecurringPeriod } from '../../models/recurring.js';
import { ClassificationMethod, TransactionStatus } from '../../models/transaction.js';

export const currencies = sqliteTable('currencies', {
  code: text('code').primaryKey(),
  symbol: text('symbol').notNull(),
  name: text('name').notNull(),
  // Fractional digits for display/rounding (fiat 2, USDC 6, BTC 8) — ADR-026 Phase 1. Defaults to
  // fiat's 2 so the migration backfill needs no per-row logic.
  decimals: integer('decimals').notNull().default(2),
});

export const accounts = sqliteTable('accounts', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  type: text('type', { enum: ['checking', 'savings', 'wallet', 'investment', 'credit'] }).notNull(),
  initialBalance: real('initial_balance').notNull().default(0),
  currency: text('currency')
    .notNull()
    .references(() => currencies.code),
  // Optimistic-concurrency token for the generic versioned unit of work (ADR-021); unread/unbumped
  // by any flow not yet converted off its own repo write method.
  version: integer('version').notNull().default(0),
});

export const creditCards = sqliteTable('credit_cards', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  closingDay: integer('closing_day').notNull(),
  dueDay: integer('due_day').notNull(),
  limitAmount: real('limit_amount'),
  currency: text('currency')
    .notNull()
    .references(() => currencies.code),
  accountId: text('account_id')
    .notNull()
    .references(() => accounts.id),
  paymentAccountId: text('payment_account_id').references(() => accounts.id),
  version: integer('version').notNull().default(0),
});

export const categories = sqliteTable(
  'categories',
  {
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    kind: text('kind', { enum: ['expense', 'income', 'both'] }).notNull(),
    parentId: text('parent_id'),
    names: text('names'),
    version: integer('version').notNull().default(0),
  },
  (t) => [foreignKey({ columns: [t.parentId], foreignColumns: [t.id] })],
);

export const merchants = sqliteTable('merchants', {
  key: text('key').primaryKey(),
});

export const merchantCategory = sqliteTable(
  'merchant_category',
  {
    merchantKey: text('merchant_key')
      .notNull()
      .references(() => merchants.key),
    categoryId: text('category_id')
      .notNull()
      .references(() => categories.id, { onDelete: 'cascade' }),
    weight: real('weight').notNull().default(1),
    origin: text('origin', { enum: [ClassificationMethod.enum.rule, ClassificationMethod.enum.history] }).notNull(),
    lastSeen: integer('last_seen'),
  },
  (t) => [primaryKey({ columns: [t.merchantKey, t.categoryId] })],
);

export const tags = sqliteTable('tags', {
  id: text('id').primaryKey(),
  name: text('name').notNull().unique(),
  version: integer('version').notNull().default(0),
});

export const bills = sqliteTable(
  'bills',
  {
    id: text('id').primaryKey(),
    creditCardId: text('credit_card_id')
      .notNull()
      .references(() => creditCards.id),
    month: integer('month').notNull(),
    year: integer('year').notNull(),
    closeDate: text('close_date').notNull(),
    dueDate: text('due_date').notNull(),
    status: text('status', { enum: ['open', 'closed', 'paid'] }).notNull(),
    paymentTransactionId: text('payment_transaction_id').references((): AnySQLiteColumn => transactions.id),
    version: integer('version').notNull().default(0),
  },
  (t) => [uniqueIndex('bills_card_month_year').on(t.creditCardId, t.month, t.year)],
);

export const transactions = sqliteTable(
  'transactions',
  {
    id: text('id').primaryKey(),
    description: text('description').notNull(),
    amount: real('amount').notNull(),
    type: text('type', { enum: ['income', 'expense', 'transfer'] }).notNull(),
    status: text('status', { enum: TransactionStatus.options }).notNull().default(TransactionStatus.enum.effective),
    date: text('date').notNull(),
    currency: text('currency')
      .notNull()
      .references(() => currencies.code),
    source: text('source', { enum: ['mcp', 'rest', 'import'] }).notNull(),
    idempotencyKey: text('idempotency_key').notNull().unique(),
    classificationMethod: text('classification_method', { enum: ClassificationMethod.options }).notNull(),
    confidence: real('confidence').notNull(),
    rawInput: text('raw_input'),
    fromAccountId: text('from_account_id').references(() => accounts.id),
    toAccountId: text('to_account_id').references(() => accounts.id),
    creditCardId: text('credit_card_id').references(() => creditCards.id),
    categoryId: text('category_id').references(() => categories.id),
    subcategoryId: text('subcategory_id').references(() => categories.id),
    merchantKey: text('merchant_key').references(() => merchants.key),
    note: text('note'),
    billId: text('bill_id').references(() => bills.id),
    version: integer('version').notNull().default(0),
  },
  (t) => [
    index('idx_transactions_date').on(t.date),
    index('idx_transactions_from_account').on(t.fromAccountId),
    index('idx_transactions_to_account').on(t.toAccountId),
    index('idx_transactions_category').on(t.categoryId),
    index('idx_transactions_status_date').on(t.status, t.date),
    // sub-category requires a parent category
    check('subcategory_requires_category', sql`${t.subcategoryId} IS NULL OR ${t.categoryId} IS NOT NULL`),
  ],
);

export const transactionTags = sqliteTable(
  'transaction_tags',
  {
    transactionId: text('transaction_id')
      .notNull()
      .references(() => transactions.id, { onDelete: 'cascade' }),
    tagId: text('tag_id')
      .notNull()
      .references(() => tags.id, { onDelete: 'cascade' }),
  },
  (t) => [primaryKey({ columns: [t.transactionId, t.tagId] })],
);

export const recurringRules = sqliteTable('recurring_rules', {
  id: text('id').primaryKey(),
  description: text('description').notNull(),
  amount: real('amount').notNull(),
  type: text('type', { enum: ['income', 'expense'] }).notNull(),
  period: text('period', { enum: RecurringPeriod.options }).notNull(),
  nextDue: text('next_due').notNull(),
  currency: text('currency')
    .notNull()
    .references(() => currencies.code),
  accountId: text('account_id').references(() => accounts.id),
  categoryId: text('category_id').references(() => categories.id),
  merchantKey: text('merchant_key').references(() => merchants.key),
  version: integer('version').notNull().default(0),
});

export const dashboards = sqliteTable(
  'dashboards',
  {
    id: text('id').primaryKey(),
    name: text('name').notNull().unique(),
    // Nullable — a source: 'file' row resolves content from `path` at read time instead
    // (ADR-027 Phase 2); exactly one of html/path is non-null per source, enforced below.
    html: text('html'),
    source: text('source', { enum: DashboardSource.options }).notNull().default(DashboardSource.enum.inline),
    path: text('path'),
    updatedAt: text('updated_at').notNull(),
    version: integer('version').notNull().default(0),
  },
  (t) => [
    check(
      'dashboard_source_content',
      sql`(${t.source} = 'inline' AND ${t.html} IS NOT NULL AND ${t.path} IS NULL) OR (${t.source} = 'file' AND ${t.html} IS NULL AND ${t.path} IS NOT NULL)`,
    ),
  ],
);

export const budgets = sqliteTable(
  'budgets',
  {
    id: text('id').primaryKey(),
    // The budgeted node's own id — a top-level category or sub-category (both rows in
    // `categories`); one column, so `UNIQUE` needs no nullable discriminator (Feature Design 015).
    categoryId: text('category_id')
      .notNull()
      .references(() => categories.id),
    currency: text('currency')
      .notNull()
      .references(() => currencies.code),
    limitAmount: real('limit_amount').notNull(),
    period: text('period', { enum: BudgetPeriod.options }).notNull().default(BudgetPeriod.enum.monthly),
    version: integer('version').notNull().default(0),
  },
  (t) => [uniqueIndex('budgets_category_currency_period').on(t.categoryId, t.currency, t.period)],
);

export const settings = sqliteTable('settings', {
  id: text('id').primaryKey().default('singleton'),
  locale: text('locale', { enum: Locale.options }).notNull().default(Locale.enum.en),
  localeSource: text('locale_source', { enum: LocaleSource.options }).notNull().default(LocaleSource.enum.default),
  // Nullable — unset means "derive from locale" (pt->BRL, en/es->USD), resolved at read time by
  // logic/locale.ts's resolveBaseCurrency (ADR-026 Phase 2); no DB default, unlike locale/localeSource,
  // since there is no third "explicit vs inferred" source to track here.
  baseCurrency: text('base_currency').references(() => currencies.code),
  version: integer('version').notNull().default(0),
});

export const currencyRates = sqliteTable(
  'currency_rates',
  {
    id: text('id').primaryKey(),
    // 1 unit of fromCode = `rate` units of toCode, as of `asOf` (ADR-026 Phase 2).
    fromCode: text('from_code')
      .notNull()
      .references(() => currencies.code),
    toCode: text('to_code')
      .notNull()
      .references(() => currencies.code),
    rate: real('rate').notNull(),
    asOf: text('as_of').notNull(),
    // Free-text provenance (e.g. "PTAX", "coingecko") — agent-supplied, never validated against a
    // fixed list; nullable since the agent may not always report one.
    source: text('source'),
    version: integer('version').notNull().default(0),
  },
  (t) => [uniqueIndex('currency_rates_from_to').on(t.fromCode, t.toCode)],
);

// ADR-033 §2/§7. `username`/`password_hash` are null until the owner row (inserted by migration on
// every database) is claimed through the setup code; `username` holds the normalized form, so the
// plain UNIQUE index is case-insensitive.
export const users = sqliteTable('users', {
  id: text('id').primaryKey(),
  username: text('username').unique(),
  passwordHash: text('password_hash'),
  role: text('role', { enum: UserRole.options }).notNull(),
  createdAt: text('created_at').notNull(),
  disabledAt: text('disabled_at'),
  version: integer('version').notNull().default(0),
});

// Only sha256(token) is stored — a database read never yields a usable session.
export const sessions = sqliteTable('sessions', {
  id: text('id').primaryKey(),
  userId: text('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  tokenHash: text('token_hash').notNull().unique(),
  createdAt: text('created_at').notNull(),
  lastSeenAt: text('last_seen_at').notNull(),
  expiresAt: text('expires_at').notNull(),
  version: integer('version').notNull().default(0),
});

// Only sha256(token) is stored; `prefix` is display-only. `scopes` is a JSON array of the `Scope` enum.
export const accessTokens = sqliteTable('access_tokens', {
  id: text('id').primaryKey(),
  userId: text('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  tokenHash: text('token_hash').notNull().unique(),
  prefix: text('prefix').notNull(),
  scopes: text('scopes', { mode: 'json' }).$type<Scope[]>().notNull(),
  createdAt: text('created_at').notNull(),
  lastUsedAt: text('last_used_at'),
  expiresAt: text('expires_at'),
  revokedAt: text('revoked_at'),
  version: integer('version').notNull().default(0),
});

export const setupCodes = sqliteTable('setup_codes', {
  id: text('id').primaryKey(),
  codeHash: text('code_hash').notNull().unique(),
  createdAt: text('created_at').notNull(),
  expiresAt: text('expires_at').notNull(),
  usedAt: text('used_at'),
  version: integer('version').notNull().default(0),
});
