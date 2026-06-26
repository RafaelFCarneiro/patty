import { z } from 'zod'
import { LocalizedNames } from './category.js'
import { CurrencyCode, Id, IsoDate, Money } from './common.js'
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

export const Classification = z.object({
  method: ClassificationMethod,
  confidence: z.number().min(0).max(1),
})
export type Classification = z.infer<typeof Classification>

export const TransactionSource = z.enum(['mcp', 'rest', 'import'])
export type TransactionSource = z.infer<typeof TransactionSource>

export const NOTE_MAX_LENGTH = 1000

/** Domain entity: core node properties + edge refs handed to the persistence diplomat. */
export const Transaction = z.object({
  id: Id,
  description: z.string().min(1),
  amount: Money,
  type: TransactionType,
  status: TransactionStatus,
  date: IsoDate,
  currency: CurrencyCode,
  source: TransactionSource,
  idempotencyKey: z.string().min(1),
  classification: Classification,
  rawInput: z.string().optional(),
  note: z.string().min(1).max(NOTE_MAX_LENGTH).optional(),
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
export type Transaction = z.infer<typeof Transaction>

/** Read projection: Transaction with joined reference names (account, category, merchant, …). */
export const TransactionView = z.object({
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
  classification: Classification,
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
export type TransactionView = z.infer<typeof TransactionView>

/** Internal projection carrying the raw localized-names maps from the DB.
 *  Used only in the adapter→controller pipeline; stripped before serialization. */
export const RawTransactionView = TransactionView.extend({
  categoryNames: LocalizedNames.optional(),
  subCategoryNames: LocalizedNames.optional(),
})
export type RawTransactionView = z.infer<typeof RawTransactionView>

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

/** Natural input accepted by controllers: names instead of ids, optional date/currency. */
export type CreateTransactionInput = {
  description: string
  amount: number
  type: MovementType
  status?: TransactionStatus
  date?: string
  account?: string
  card?: string
  category?: string
  subCategory?: string
  currency?: CurrencyCode
  idempotencyKey: string
  rawInput?: string
  note?: string
  tags?: string[]
}

export type BulkTransactionItem = Omit<CreateTransactionInput, 'idempotencyKey' | 'rawInput'> & {
  idempotencyKey?: string
}

export type CreateTransactionsBulkInput = {
  items: BulkTransactionItem[]
  account?: string
  card?: string
  rawInput?: string
}

export type CreateTransferInput = {
  from: string
  to: string
  amount: number
  status?: TransactionStatus
  date?: string
  description?: string
  idempotencyKey: string
}

export type UpdateTransactionInput = {
  id: string
  description?: string
  amount?: number
  type?: MovementType
  date?: string
  account?: string
  category?: string
  subCategory?: string
  /** When provided, sets the note; empty string clears it. Omit to leave untouched. */
  note?: string
  /** When provided (including empty array), replaces the full tag set. Omit to leave tags unchanged. */
  tags?: string[]
}

export type SearchTransactionsInput = {
  month?: number
  year?: number
  from?: string
  to?: string
  type?: TransactionType
  status?: TransactionStatus
  category?: string
  subCategory?: string
  account?: string
  text?: string
  tags?: string[]
  limit: number
}

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
  | ValidationError

export const transactionErrors = {
  notFound: (id: string): TransactionError => ({ code: 'unknown_transaction', id }),
}
