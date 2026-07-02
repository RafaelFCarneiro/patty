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
} from 'drizzle-orm/sqlite-core';
import { sql } from 'drizzle-orm';
import { Locale, LocaleSource } from '../../models/locale.js';
import { RecurringPeriod } from '../../models/recurring.js';
import { ClassificationMethod, TransactionStatus } from '../../models/transaction.js';

export const currencies = sqliteTable('currencies', {
  code: text('code').primaryKey(),
  symbol: text('symbol').notNull(),
  name: text('name').notNull(),
});

export const accounts = sqliteTable('accounts', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  type: text('type', { enum: ['checking', 'savings', 'wallet', 'investment', 'credit'] }).notNull(),
  initialBalance: real('initial_balance').notNull().default(0),
  currency: text('currency')
    .notNull()
    .references(() => currencies.code),
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
});

export const categories = sqliteTable(
  'categories',
  {
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    kind: text('kind', { enum: ['expense', 'income', 'both'] }).notNull(),
    parentId: text('parent_id'),
    names: text('names'),
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
      .references(() => categories.id),
    weight: real('weight').notNull().default(1),
    origin: text('origin', { enum: [ClassificationMethod.enum.rule, ClassificationMethod.enum.history] }).notNull(),
    lastSeen: integer('last_seen'),
  },
  (t) => [primaryKey({ columns: [t.merchantKey, t.categoryId] })],
);

export const tags = sqliteTable('tags', {
  id: text('id').primaryKey(),
  name: text('name').notNull().unique(),
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
});

export const dashboards = sqliteTable('dashboards', {
  name: text('name').primaryKey(),
  html: text('html').notNull(),
  updatedAt: text('updated_at').notNull(),
});

export const settings = sqliteTable('settings', {
  id: text('id').primaryKey().default('singleton'),
  locale: text('locale', { enum: Locale.options }).notNull().default(Locale.enum.en),
  localeSource: text('locale_source', { enum: LocaleSource.options }).notNull().default(LocaleSource.enum.default),
});
