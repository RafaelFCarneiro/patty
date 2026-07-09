import { z } from 'zod';
import { BillQuerySchema } from './bill.js';
import { LocalizedNamesSchema } from './category.js';
import { IsoDate } from './date.js';
import { Id } from './id.js';
import { CurrencyCode, Money } from './money.js';
import { cursorSchema, PageRequestSchema, SortDirection } from './page.js';
import type { CursorKey } from './page.js';
import type { CategoryKind } from './category.js';
import type { ValidationError } from './error.js';
import type { LabelMap } from './locale.js';

/** Whether the transaction has cleared or is still expected. Default is date-aware when omitted. */
export const TransactionStatus = z.enum(['pending', 'effective']);
export type TransactionStatus = z.infer<typeof TransactionStatus>;

export const transactionStatusLabels: LabelMap<TransactionStatus> = {
  pending: { en: 'Pending', pt: 'Pendente', es: 'Pendiente' },
  effective: { en: 'Effective', pt: 'Efetivada', es: 'Efectiva' },
};

/** 'transfer' moves value between accounts: FROM + TO edges, excluded from summaries. */
export const TransactionType = z.enum(['expense', 'income', 'transfer']);
export type TransactionType = z.infer<typeof TransactionType>;

export const transactionTypeLabels: LabelMap<TransactionType> = {
  expense: { en: 'Expense', pt: 'Despesa', es: 'Gasto' },
  income: { en: 'Income', pt: 'Receita', es: 'Ingreso' },
  transfer: { en: 'Transfer', pt: 'Transferência', es: 'Transferencia' },
};

/** Types accepted by create_transaction / bulk — transfers go through create_transfer. */
export const MovementType = z.enum(['expense', 'income']);
export type MovementType = z.infer<typeof MovementType>;

export const ClassificationMethod = z.enum(['rule', 'history', 'user', 'none']);
export type ClassificationMethod = z.infer<typeof ClassificationMethod>;

export const ClassificationSchema = z.object({
  method: ClassificationMethod,
  confidence: z.number().min(0).max(1),
});
export type Classification = z.infer<typeof ClassificationSchema>;

export const TransactionSource = z.enum(['mcp', 'rest', 'import']);
export type TransactionSource = z.infer<typeof TransactionSource>;

/** search_transactions whitelisted sort fields (ADR-011/014): the only values diplomat/db's
 *  ORDER BY fragment map accepts — caller text never reaches SQL structure. */
export const TransactionSortField = z.enum(['date', 'amount']);
export type TransactionSortField = z.infer<typeof TransactionSortField>;

/** Structural shape only — `resolveCursorKey` (logic/transaction.ts) is what checks `key.value`
 *  is actually well-formed for its own `sort` field, alongside the sort/dir-match check it
 *  already does; that's a cross-field business rule, not a schema shape. */
export const TransactionCursorSchema = cursorSchema(TransactionSortField);
export type TransactionCursor = z.infer<typeof TransactionCursorSchema>;

export const NOTE_MAX_LENGTH = 1000;

// `.describe()` is domain information — it states what each field is and represents.
// Defaults split by intent: integrity defaults (a value that must exist for the entity to be
// valid) live here; quality-of-life convenience defaults live at the wire boundary
// (see wire/in/transactions.ts), keeping the domain contract honest about what is required.

/** Domain entity: core node properties + edge refs handed to the persistence diplomat. */
export const TransactionSchema = z.object({
  id: Id,
  description: z.string().min(1).describe('What was paid/received'),
  amount: Money.describe('Positive amount in full units (reais/dollars)'),
  type: TransactionType,
  status: TransactionStatus,
  date: IsoDate.describe('Transaction date (YYYY-MM-DD)'),
  currency: CurrencyCode.describe('Transaction currency (ISO code)'),
  source: TransactionSource,
  idempotencyKey: z.string().min(1),
  classification: ClassificationSchema,
  rawInput: z.string().optional().describe('Original user phrasing, for audit'),
  note: z
    .string()
    .min(1)
    .max(NOTE_MAX_LENGTH)
    .optional()
    .describe('Free-form memo (observação) — distinct from description/rawInput/tags'),
  refs: z.object({
    accountId: Id.optional(),
    toAccountId: Id.optional(),
    cardId: Id.optional(),
    billId: Id.optional(),
    categoryId: Id.optional(),
    subCategoryId: Id.optional(),
    merchantKey: z.string().optional(),
  }),
});
export type Transaction = z.infer<typeof TransactionSchema>;

/** Read projection: Transaction with joined reference names (account, category, merchant, …). */
export const TransactionViewSchema = z.object({
  id: Id,
  description: z.string().min(1),
  amount: Money,
  type: TransactionType,
  typeLabel: z.string().optional(),
  status: TransactionStatus,
  statusLabel: z.string().optional(),
  date: IsoDate,
  currency: CurrencyCode,
  source: TransactionSource,
  idempotencyKey: z.string().min(1),
  classification: ClassificationSchema,
  rawInput: z.string().optional(),
  note: z.string().min(1).max(NOTE_MAX_LENGTH).optional(),
  accountId: Id.optional(),
  accountName: z.string().optional(),
  /** Destination account — present only on type 'transfer'. */
  toAccountId: Id.optional(),
  toAccountName: z.string().optional(),
  cardId: Id.optional(),
  cardName: z.string().optional(),
  /** The bill (fatura) this card transaction currently belongs to — absent for account transactions. */
  billId: Id.optional(),
  categoryId: Id.optional(),
  categoryName: z.string().optional(),
  subCategoryId: Id.optional(),
  subCategoryName: z.string().optional(),
  merchant: z.string().optional(),
  tags: z.array(z.string().min(1)).default([]),
});
export type TransactionView = z.infer<typeof TransactionViewSchema>;

/** Internal projection carrying the raw localized-names maps from the DB.
 *  Used only in the adapter→controller pipeline; stripped before serialization. */
export const RawTransactionViewSchema = TransactionViewSchema.extend({
  categoryNames: LocalizedNamesSchema.optional(),
  subCategoryNames: LocalizedNamesSchema.optional(),
});
export type RawTransactionView = z.infer<typeof RawTransactionViewSchema>;

/** Domain patch for updates — only provided fields change; classification set on user correction. */
export type TransactionPatch = {
  description?: string;
  amount?: number;
  type?: MovementType;
  status?: TransactionStatus;
  date?: string;
  currency?: CurrencyCode;
  classification?: Classification;
  note?: string;
};

// ─── Input contracts ──────────────────────────────────────────
// Zod-first, types inferred. Wire derives from these (re-export / extend).

/**
 * A category-or-subcategory-by-name selection — how a transaction create/update/search request
 * references a category. Embedded (not the category/sub-category entities themselves, which live
 * in models/category.ts).
 */
export const CategoryFieldsSchema = z.object({
  category: z.string().min(1).optional().describe('Category name'),
  subCategory: z.string().min(1).optional().describe('Sub-category name (implies its parent category)'),
});
export type CategoryFields = z.infer<typeof CategoryFieldsSchema>;

/** Natural input accepted by controllers: names instead of ids. */
export const CreateTransactionSchema = z.object({
  description: z.string().min(1).describe('What was paid/received, e.g. "Uber para o aeroporto"'),
  amount: Money.describe('Positive amount in full units (reais/dollars)'),
  type: MovementType.describe('expense | income'),
  status: TransactionStatus.optional().describe(
    'Omit for date-aware default (future → pending, today/past → effective). ' +
      '"effective" = cleared, counts in balances/summaries. ' +
      '"pending" = expected, excluded until confirmed.',
  ),
  date: IsoDate.optional().describe('YYYY-MM-DD; defaults to today'),
  account: z.string().min(1).optional().describe('Account name, e.g. "Nubank"'),
  card: z.string().min(1).optional().describe('Credit card name — joins the cycle bill. Use account OR card, not both'),
  billMonth: BillQuerySchema.shape.month
    .optional()
    .describe(
      'Explicit target bill cycle month (1-12) for a card transaction; overrides cycle-based auto-assignment. ' +
        'Provide with billYear together; requires card. Auto-creates the bill if that cycle has none yet',
    ),
  billYear: BillQuerySchema.shape.year.optional().describe('Explicit target bill cycle year; provide with billMonth'),
  // Spread first so a future CategoryFieldsSchema field is picked up here automatically; the
  // explicit category/subCategory below override just the .describe() for this create context.
  ...CategoryFieldsSchema.shape,
  category: CategoryFieldsSchema.shape.category.describe(
    'Category name; omit to auto-classify. Must match transaction type kind',
  ),
  subCategory: CategoryFieldsSchema.shape.subCategory.describe(
    'Sub-category name (implies its parent — do not set both)',
  ),
  currency: CurrencyCode.optional().describe('Transaction currency; resolved from account/card when omitted'),
  idempotencyKey: z.string().min(1).describe('Stable dedup key, e.g. "<date>-<description>-<amount>"'),
  rawInput: z.string().optional().describe('Original user phrasing, for audit'),
  note: z.string().min(1).max(NOTE_MAX_LENGTH).optional().describe('Free-form memo (observação)'),
  tags: z.array(z.string().min(1)).optional().describe('Labels to attach, e.g. ["work", "travel"]'),
});
export type CreateTransaction = z.infer<typeof CreateTransactionSchema>;

/** Natural input for a credit-card purchase (ADR-016): same shape as create_transaction minus
 *  `account` (the card's own internal liability account is always the destination) with `card`
 *  required instead of optional. */
export const AddCardPurchaseSchema = CreateTransactionSchema.omit({ account: true }).extend({
  card: z.string().min(1).describe('Credit card name — joins the cycle bill'),
});
export type AddCardPurchase = z.infer<typeof AddCardPurchaseSchema>;

/** Bulk item: idempotencyKey optional — derived from date+description+amount when absent.
 *  subCategory/tags omitted — bulk import classifies automatically. */
export const BulkTransactionItemSchema = CreateTransactionSchema.omit({
  idempotencyKey: true,
  rawInput: true,
  subCategory: true,
  tags: true,
}).extend({
  idempotencyKey: z.string().min(1).optional(),
});
export type BulkTransactionItem = z.infer<typeof BulkTransactionItemSchema>;

export const CreateTransactionsBulkSchema = z.object({
  items: z.array(BulkTransactionItemSchema).min(1).max(200).describe('Transaction items to import'),
  account: z.string().min(1).optional().describe('Default account for all items'),
  card: z.string().min(1).optional().describe('Default credit card for all items'),
  rawInput: z.string().optional().describe('The original pasted statement text'),
});
export type CreateTransactionsBulk = z.infer<typeof CreateTransactionsBulkSchema>;

export const CreateTransferSchema = z.object({
  from: z.string().min(1).describe('Source account name'),
  to: z.string().min(1).describe('Destination account name'),
  amount: Money.describe('Transfer amount in full units'),
  status: TransactionStatus.optional().describe('pending | effective; omit for date-aware default'),
  date: IsoDate.optional().describe('YYYY-MM-DD; defaults to today'),
  description: z.string().optional().describe('e.g. "aporte mensal"'),
  idempotencyKey: z.string().min(1).describe('Stable dedup key'),
});
export type CreateTransfer = z.infer<typeof CreateTransferSchema>;

export const UpdateTransactionSchema = z.object({
  id: z.string().min(1).describe('Transaction id'),
  description: z.string().min(1).optional().describe('Updated description'),
  amount: Money.optional().describe('Updated amount in full units'),
  type: MovementType.optional().describe('Updated movement type'),
  date: IsoDate.optional().describe('Updated date (YYYY-MM-DD)'),
  account: z.string().min(1).optional().describe('New account name'),
  billMonth: BillQuerySchema.shape.month
    .optional()
    .describe(
      'Reassign to this bill cycle month (1-12) — the transaction must already be a card transaction. ' +
        'Provide with billYear together. Rejected if the current or target bill is paid; auto-creates the ' +
        'target bill if that cycle has none yet',
    ),
  billYear: BillQuerySchema.shape.year
    .optional()
    .describe('Reassignment target bill cycle year; provide with billMonth'),
  ...CategoryFieldsSchema.shape,
  category: CategoryFieldsSchema.shape.category.describe(
    'New category name (user correction). Do not set with subCategory',
  ),
  subCategory: CategoryFieldsSchema.shape.subCategory.describe(
    'New sub-category name (implies parent; do not set with category)',
  ),
  note: z
    .string()
    .max(NOTE_MAX_LENGTH)
    .optional()
    .describe('Free-form memo. Empty string clears; omit to leave unchanged'),
  tags: z
    .array(z.string().min(1))
    .optional()
    .describe('Replaces the full tag set when provided; pass [] to remove all'),
});
export type UpdateTransaction = z.infer<typeof UpdateTransactionSchema>;

export const SearchTransactionsSchema = z.object({
  month: z.number().int().min(1).max(12).optional().describe('Filter by month (1-12)'),
  year: z.number().int().min(2000).max(2100).optional().describe('Filter by year'),
  from: IsoDate.optional().describe('Start date (inclusive)'),
  to: IsoDate.optional().describe('End date (inclusive)'),
  type: TransactionType.optional().describe('Filter by type (expense/income/transfer)'),
  status: TransactionStatus.optional().describe('"pending" to list scheduled transactions; omit for all'),
  ...CategoryFieldsSchema.shape,
  category: CategoryFieldsSchema.shape.category.describe('Filter by category name'),
  subCategory: CategoryFieldsSchema.shape.subCategory.describe('Filter to transactions with this sub-category'),
  account: z.string().min(1).optional().describe('Filter by account name'),
  text: z.string().optional().describe('Free-text search in description'),
  tags: z.array(z.string().min(1)).optional().describe('Filter to transactions having any of these tags'),
  ...PageRequestSchema.shape,
  sort: TransactionSortField.describe('Field to sort by: date or amount. Default: date'),
  dir: SortDirection.describe('Sort direction: asc or desc. Default: desc'),
});
export type SearchTransactions = z.infer<typeof SearchTransactionsSchema>;

/** Name-or-period fields the controller had to resolve via a repo lookup (account/category/
 *  subCategory names → ids, month+year → a date range) or decode (the cursor) — the parts of
 *  a search that genuinely can't be derived without I/O. Everything else the repo needs already
 *  lives on `SearchTransactions` itself; `diplomat/db` combines the two into its SQL-filter shape. */
export type ResolvedSearchRefs = {
  accountId: string | null;
  categoryId: string | null;
  subCategoryId: string | null;
  from: string | null;
  to: string | null;
  cursorKey: CursorKey | null;
};

// ─── Domain result types ──────────────────────────────────────────

/** A CategoryFields name resolved to ids — categoryId is always the top-level category's id. */
export const CategorySelectionSchema = z.object({
  categoryId: Id.describe("Resolved category id (the sub-category's parent id, when a sub-category was resolved)"),
  categoryName: z.string().min(1).describe('Resolved category display name'),
  subCategoryId: Id.optional().describe('Resolved sub-category id, present only when a sub-category was selected'),
});
export type CategorySelection = z.infer<typeof CategorySelectionSchema>;

/** Classification enriched with resolved category/merchant — returned alongside every transaction write. */
export type ClassifyOutcome = Classification & {
  categoryId?: string;
  categoryName?: string;
  merchantKey?: string;
};

export type CreateTxResult = { transaction: RawTransactionView; created: boolean };

export type CreateTransactionResult = {
  transaction: TransactionView;
  created: boolean;
  classification: ClassifyOutcome;
};

export type DeleteTransactionResult =
  | { deleted: true; transaction: TransactionView }
  | { deleted: false; dryRun: true; wouldDelete: TransactionView; hint: string };

export type TransactionError =
  | { code: 'unknown_transaction'; id: string }
  | {
      code: 'category_kind_mismatch';
      transactionType: MovementType;
      categoryName: string;
      categoryKind: CategoryKind;
      hint: string;
    }
  | ValidationError;

export const transactionErrors = {
  notFound: (id: string): TransactionError => ({
    code: 'unknown_transaction',
    id,
  }),
  categoryKindMismatch: (
    transactionType: MovementType,
    categoryName: string,
    categoryKind: CategoryKind,
  ): TransactionError => ({
    code: 'category_kind_mismatch',
    transactionType,
    categoryName,
    categoryKind,
    hint: `Category "${categoryName}" is ${categoryKind}-only; to use it, set type: "${categoryKind}"`,
  }),
  exclusiveAccountCard: {
    code: 'validation',
    issues: ['provide account OR card, not both'],
  } satisfies TransactionError,
  exclusiveCategorySubCategory: {
    code: 'validation',
    issues: ['provide category OR subCategory, not both — subCategory implies its parent category'],
  } satisfies TransactionError,
  exclusiveCategorySubCategoryUpdate: {
    code: 'validation',
    issues: ['provide category OR subCategory, not both'],
  } satisfies TransactionError,
  transferTypeImmutable: {
    code: 'validation',
    issues: ['cannot change the type of a transfer transaction'],
  } satisfies TransactionError,
  transferCategoryRejected: {
    code: 'validation',
    issues: ['transfer transactions cannot have a category or sub-category'],
  } satisfies TransactionError,
  billPeriodIncomplete: {
    code: 'validation',
    issues: ['billMonth and billYear must be provided together'],
  } satisfies TransactionError,
  billAssignmentRequiresCard: {
    code: 'validation',
    issues: [
      'billMonth/billYear require a credit-card transaction; provide `card` (create) or the transaction must already have one (update)',
    ],
  } satisfies TransactionError,
  paidBillImmutable: {
    code: 'validation',
    issues: [
      'this bill is paid; its transactions cannot be added, removed, or reassigned — call revert_bill_payment first',
    ],
  } satisfies TransactionError,
  invalidCursor: {
    code: 'validation',
    issues: ['cursor is malformed, stale, or does not match the requested sort/dir — start a fresh first page'],
  } satisfies TransactionError,
};
