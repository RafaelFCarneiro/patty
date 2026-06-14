import { z } from 'zod'
import { ClassificationMethod, TransactionView } from '../../models/transaction.js'

// ─── Outbound wire schemas ────────────────────────────────────────────────────
// These are the serialized shapes that diplomats (MCP/HTTP) send to clients.
// They differ from models in two ways:
//   1. AppError is collapsed to a string message (safe for external consumers)
//   2. Zod schemas enforce the contract and serve as documentation

const ClassifyOutcomeOut = z.object({
  method: ClassificationMethod,
  confidence: z.number(),
  categoryId: z.string().optional(),
  categoryName: z.string().optional(),
  merchantKey: z.string().optional(),
})

export const CreateTransactionOut = z.object({
  transaction: TransactionView,
  created: z.boolean(),
  classification: ClassifyOutcomeOut,
})
export type CreateTransactionOut = z.infer<typeof CreateTransactionOut>

const BulkItemOut = z.discriminatedUnion('status', [
  z.object({
    status: z.literal('created'),
    transaction: TransactionView,
    classification: ClassifyOutcomeOut,
  }),
  z.object({
    status: z.literal('needs_review'),
    transaction: TransactionView,
    classification: ClassifyOutcomeOut,
  }),
  z.object({ status: z.literal('duplicate'), transaction: TransactionView }),
  z.object({ status: z.literal('error'), description: z.string(), error: z.string() }),
])
export type BulkItemOut = z.infer<typeof BulkItemOut>

export const BulkResultOut = z.object({
  summary: z.object({
    created: z.number().int(),
    needsReview: z.number().int(),
    duplicates: z.number().int(),
    errors: z.number().int(),
  }),
  items: z.array(BulkItemOut),
})
export type BulkResultOut = z.infer<typeof BulkResultOut>

export const DeleteTransactionOut = z.discriminatedUnion('deleted', [
  z.object({ deleted: z.literal(true), transaction: TransactionView }),
  z.object({
    deleted: z.literal(false),
    dryRun: z.literal(true),
    wouldDelete: TransactionView,
    hint: z.string(),
  }),
])
export type DeleteTransactionOut = z.infer<typeof DeleteTransactionOut>
