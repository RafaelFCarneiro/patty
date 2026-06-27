import { z } from 'zod'
import { LocalizedNamesSchema } from './category.js'
import { CurrencyCode, Id, IsoDate, Money } from './common.js'
import type { CategoryKind } from './category.js'
import type { ValidationError } from './error.js'
import type { LabelMap } from './locale.js'

/** Whether the transaction has cleared or is still expected. Default is date-aware when omitted. */
export const TransactionStatus = z.enum(['pending', 'effective'])
export type TransactionStatus = z.infer<typeof TransactionStatus>

export const transactionStatusLabels: LabelMap<TransactionStatus> = {
  pending:   { en: 'Pending',   pt: 'Pendente',   es: 'Pendiente' },
  effective: { en: 'Effective', pt: 'Efetivada',  es: 'Efectiva' },
}

/** 'transfer' moves value between accounts: FROM + TO edges, excluded from summaries. */
export const TransactionType = z.enum(['expense', 'income', 'transfer'])
export type TransactionType = z.infer<typeof TransactionType>

export const transactionTypeLabels: LabelMap<TransactionType> = {
  expense:  { en: 'Expense',  pt: 'Despesa',       es: 'Gasto' },
  income:   { en: 'Income',   pt: 'Receita',       es: 'Ingreso' },
  transfer: { en: 'Transfer', pt: 'Transferência', es: 'Transferencia' },
}

/** Types accepted by create_transaction / bulk — transfers go through create_transfer. */
export const MovementType = z.enum(['expense', 'income'])
export type MovementType = z.infer<typeof MovementType>

export const ClassificationMethod = z.enum(['rule', 'history', 'user', 'none'])
export type ClassificationMethod = z.infer<typeof ClassificationMethod>

export const ClassificationSchema = z.object({
  method: ClassificationMethod,
  confidence: z.number().min(0).max(1),
})
export type Classification = z.infer<typeof ClassificationSchema>

export const TransactionSource = z.enum(['mcp', 'rest', 'import'])
export type TransactionSource = z.infer<typeof TransactionSource>

export const NOTE_MAX_LENGTH = 1000

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
  note: z.string().min(1).max(NOTE_MAX_LENGTH).optional().describe('Free-form memo (observação) — distinct from description/rawInput/tags'),
  refs: z.object({
    accountId: Id.optional(),
    toAccountId: Id.optional(),
    cardId: Id.optional(),
    billId: Id.optional(),
    categoryId: Id.optional(),
    subCategoryId: Id.optional(),
    merchantKey: z.string().optional(),
  }),
})
export type Transaction = z.infer<typeof TransactionSchema>

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
  categoryId: Id.optional(),
  categoryName: z.string().optional(),
  subCategoryId: Id.optional(),
  subCategoryName: z.string().optional(),
  merchant: z.string().optional(),
  tags: z.array(z.string().min(1)).default([]),
})
export type TransactionView = z.infer<typeof TransactionViewSchema>

/** Internal projection carrying the raw localized-names maps from the DB.
 *  Used only in the adapter→controller pipeline; stripped before serialization. */
export const RawTransactionViewSchema = TransactionViewSchema.extend({
  categoryNames: LocalizedNamesSchema.optional(),
  subCategoryNames: LocalizedNamesSchema.optional(),
})
export type RawTransactionView = z.infer<typeof RawTransactionViewSchema>

/** Domain patch for updates — only provided fields change; classification set on user correction. */
export type TransactionPatch = {
  description?: string
  amount?: number
  type?: MovementType
  status?: TransactionStatus
  date?: string
  currency?: CurrencyCode
  classification?: Classification
  note?: string
}

// ─── Input contracts ─────────────────────────────────────────────────────────
// Zod-first, types inferred. Wire derives from these (re-export / extend).

/** Natural input accepted by controllers: names instead of ids, optional date/currency. */
export const CreateTransactionSchema = z.object({
  description: z.string().min(1).describe('What was paid/received, e.g. "Uber para o aeroporto"'),
  amount: Money.describe('Positive amount in full units (reais/dollars)'),
  type: MovementType.describe('expense | income'),
  status: TransactionStatus.optional().describe(
    'Omit to use the date-aware default (future date → pending, today/past → effective). ' +
    '"effective" = already happened, counts toward balances and summaries. ' +
    '"pending" = expected but not yet cleared, excluded until confirmed.',
  ),
  date: IsoDate.optional().describe('YYYY-MM-DD; defaults to today'),
  account: z.string().optional().describe('Account name, e.g. "Nubank"'),
  card: z.string().optional().describe('Credit card name — transaction joins the cycle bill (fatura). Use account OR card, not both'),
  category: z.string().optional().describe('Category name; omit when using subCategory or to auto-classify. expense transactions need an expense/both category; income needs income/both'),
  subCategory: z.string().optional().describe('Sub-category name (implies its parent category — do not set both category and subCategory)'),
  currency: CurrencyCode.optional().describe('Transaction currency; resolved from account/card when omitted'),
  idempotencyKey: z.string().min(1).describe('Stable dedup key, e.g. "<date>-<description>-<amount>"'),
  rawInput: z.string().optional().describe('Original user phrasing, for audit'),
  note: z.string().min(1).max(NOTE_MAX_LENGTH).optional().describe('Free-form memo (observação) — distinct from description/rawInput/tags'),
  tags: z.array(z.string().min(1)).optional().describe('Labels to attach, e.g. ["work", "travel"]'),
})
export type CreateTransaction = z.infer<typeof CreateTransactionSchema>

/** Bulk item: idempotencyKey optional — derived from date+description+amount when absent. */
export const BulkTransactionItemSchema = CreateTransactionSchema.omit({
  idempotencyKey: true,
  rawInput: true,
}).extend({
  idempotencyKey: z.string().min(1).optional(),
})
export type BulkTransactionItem = z.infer<typeof BulkTransactionItemSchema>

export const CreateTransactionsBulkSchema = z.object({
  items: z.array(BulkTransactionItemSchema).min(1).max(200).describe('Transaction items to import'),
  account: z.string().optional().describe('Default account for all items'),
  card: z.string().optional().describe('Default credit card for all items'),
  rawInput: z.string().optional().describe('The original pasted statement text'),
})
export type CreateTransactionsBulk = z.infer<typeof CreateTransactionsBulkSchema>

export const CreateTransferSchema = z.object({
  from: z.string().min(1).describe('Source account name'),
  to: z.string().min(1).describe('Destination account name'),
  amount: Money.describe('Transfer amount in full units'),
  status: TransactionStatus.optional().describe('pending | effective; omit for date-aware default'),
  date: IsoDate.optional().describe('YYYY-MM-DD; defaults to today'),
  description: z.string().optional().describe('e.g. "aporte mensal"'),
  idempotencyKey: z.string().min(1).describe('Stable dedup key'),
})
export type CreateTransfer = z.infer<typeof CreateTransferSchema>

export const UpdateTransactionSchema = z.object({
  id: z.string().min(1).describe('Transaction id'),
  description: z.string().min(1).optional().describe('Updated description'),
  amount: Money.optional().describe('Updated amount in full units'),
  type: MovementType.optional().describe('Updated movement type'),
  date: IsoDate.optional().describe('Updated date (YYYY-MM-DD)'),
  account: z.string().optional().describe('New account name'),
  category: z.string().optional().describe('New category name (user correction). Do not set together with subCategory'),
  subCategory: z.string().optional().describe('New sub-category name (implies parent category; do not set together with category)'),
  note: z.string().max(NOTE_MAX_LENGTH).optional().describe('Free-form memo (observação). Empty string clears; omit to leave unchanged'),
  tags: z.array(z.string().min(1)).optional().describe('Replaces the full tag set when provided; pass [] to remove all tags'),
})
export type UpdateTransaction = z.infer<typeof UpdateTransactionSchema>

export const SearchTransactionsSchema = z.object({
  month: z.number().int().min(1).max(12).optional().describe('Filter by month (1-12)'),
  year: z.number().int().min(2000).max(2100).optional().describe('Filter by year'),
  from: IsoDate.optional().describe('Start date (inclusive)'),
  to: IsoDate.optional().describe('End date (inclusive)'),
  type: TransactionType.optional().describe('Filter by type (expense/income/transfer)'),
  status: TransactionStatus.optional().describe('"pending" to list scheduled transactions; omit for all'),
  category: z.string().optional().describe('Filter by category name'),
  subCategory: z.string().optional().describe('Filter to transactions with this sub-category'),
  account: z.string().optional().describe('Filter by account name'),
  text: z.string().optional().describe('Free-text search in description'),
  tags: z.array(z.string().min(1)).optional().describe('Filter to transactions having any of these tags'),
  limit: z.number().int().min(1).max(200).describe('Maximum results to return'),
})
export type SearchTransactions = z.infer<typeof SearchTransactionsSchema>

// ─── Domain result types ──────────────────────────────────────────────────────

/** Classification enriched with resolved category/merchant — returned alongside every transaction write. */
export type ClassifyOutcome = Classification & {
  categoryId?: string
  categoryName?: string
  merchantKey?: string
}

export type CreateTransactionResult = {
  transaction: TransactionView
  created: boolean
  classification: ClassifyOutcome
}

export type DeleteTransactionResult =
  | { deleted: true; transaction: TransactionView }
  | { deleted: false; dryRun: true; wouldDelete: TransactionView; hint: string }

export type TransactionError =
  | { code: 'unknown_transaction'; id: string }
  | { code: 'category_kind_mismatch'; transactionType: MovementType; categoryName: string; categoryKind: CategoryKind; hint: string }
  | ValidationError

export const transactionErrors = {
  notFound: (id: string): TransactionError => ({ code: 'unknown_transaction', id }),
  categoryKindMismatch: (transactionType: MovementType, categoryName: string, categoryKind: CategoryKind): TransactionError => ({
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
}
