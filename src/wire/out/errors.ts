import { z } from 'zod';

// Wire shape of `{ error: AppError }` responses. `common/errors.ts` owns the AppError union and
// its httpStatus mapping (every code resolves to exactly one of 404 / 409 / 422) — but that
// mapping is many-to-one: several distinct AppError shapes share the same HTTP status
// (models/error.ts's shared primitives, plus the transaction/bill one-offs below), so each
// status bucket is documented as a union of every shape reachable at that status, not a single
// uniform shape.

// unknown_*/ambiguous_* (account, category, sub_category, card) — models/error.ts's
// NotFound<E>/Ambiguous<E>.
const ResolutionErrorOut = z.object({ code: z.string(), query: z.string(), candidates: z.array(z.string()) });

// unknown_transaction has its own shape (models/transaction.ts) — an id, not query/candidates.
const UnknownTransactionErrorOut = z.object({ code: z.literal('unknown_transaction'), id: z.string() });

// unknown_bill has its own shape (models/bill.ts) — no query/candidates either.
const UnknownBillErrorOut = z.object({
  code: z.literal('unknown_bill'),
  card: z.string(),
  month: z.number(),
  year: z.number(),
});

// duplicate_name (models/error.ts's DuplicateName<E>).
const DuplicateNameErrorOut = z.object({ code: z.literal('duplicate_name'), entity: z.string(), name: z.string() });

// in_use (models/error.ts's InUse<E, R>) — `references` shape varies per entity
// (AccountReferences vs CategoryReferences have different field names), so it's left loose.
const InUseErrorOut = z.object({
  code: z.literal('in_use'),
  entity: z.string(),
  name: z.string(),
  references: z.record(z.string(), z.unknown()),
});

// The generic validation shape (models/error.ts's ValidationError) — used by every domain's
// `code: 'validation'` errors (accounts, categories, credit cards, transfers, ...).
// `hint` (optional) names the operation to use instead, in the edge's own words ("use POST /api/bills/pay").
const GenericValidationErrorOut = z.object({
  code: z.literal('validation'),
  issues: z.array(z.string()),
  hint: z.string().optional(),
});

// conflict (models/error.ts's Conflict) — the versioned unit of work's generic optimistic-
// concurrency failure (ADR-021); no business payload, by design.
const VersionConflictErrorOut = z.object({ code: z.literal('conflict') });

// category_kind_mismatch has its own shape (models/transaction.ts) — only reachable from
// create/update transaction.
const CategoryKindMismatchErrorOut = z.object({
  code: z.literal('category_kind_mismatch'),
  transactionType: z.string(),
  categoryName: z.string(),
  categoryKind: z.string(),
  hint: z.string(),
});

export const NotFoundErrorOut = z.object({
  error: z.union([ResolutionErrorOut, UnknownTransactionErrorOut, UnknownBillErrorOut]),
});
export type NotFoundErrorOut = z.infer<typeof NotFoundErrorOut>;

export const ConflictErrorOut = z.object({
  error: z.union([ResolutionErrorOut, DuplicateNameErrorOut, InUseErrorOut, VersionConflictErrorOut]),
});
export type ConflictErrorOut = z.infer<typeof ConflictErrorOut>;

export const ValidationErrorOut = z.object({
  error: z.union([GenericValidationErrorOut, CategoryKindMismatchErrorOut]),
});
export type ValidationErrorOut = z.infer<typeof ValidationErrorOut>;
