import { z } from 'zod';
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

/** Types accepted by add_card_purchase / add_account_expense / add_account_income /
 *  import_card_statement / import_account_statement — transfers go through create_transfer. */
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

// Shared statement-import field descriptions (ADR-017 step 2) — both ImportCardStatementItemSchema
// (models/creditCard.ts) and ImportAccountStatementItemSchema/ImportCardStatementSchema/
// ImportAccountStatementSchema reuse these verbatim; named once here so the two aggregate schemas
// never copy-paste the same describe() text (code-quality.md "constants over literals").
export const STATEMENT_IDEMPOTENCY_KEY_DESCRIPTION =
  'Stable dedup key; derived from date+description+amount when absent';
export const STATEMENT_ITEMS_DESCRIPTION = 'Statement lines to import';
export const STATEMENT_RAW_INPUT_DESCRIPTION = 'The original pasted statement text';

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

// The transaction aggregate owns its own entity tag (ADR-021), mirroring `models/account.ts`'s
// `ACCOUNT_ENTITY_TAG` — `models/persistable.ts` is generic over any entity's tag/model and never
// lists this constant itself.
export const TRANSACTION_ENTITY_TAG = 'transaction';

// Same shape as Transaction, kept distinct for call-site clarity at every Persistable builder.
export type TransactionEntity = Transaction;

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

/** Internal projection carrying the raw localized-names maps from the DB, plus the optimistic-
 *  concurrency `version` token (ADR-021) an account-context update/delete reads before deciding
 *  its `Persistable`. Used only in the adapter→controller pipeline; stripped before serialization
 *  (`logic/transaction.ts`'s `addLocalizedLabels` drops both `*Names` and `version`). */
export const RawTransactionViewSchema = TransactionViewSchema.extend({
  categoryNames: LocalizedNamesSchema.optional(),
  subCategoryNames: LocalizedNamesSchema.optional(),
  version: z.number().int().nonnegative().describe('Optimistic-concurrency token; internal, never on wire/out'),
});
export type RawTransactionView = z.infer<typeof RawTransactionViewSchema>;

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

/** Minimal shared movement vocabulary (ADR-019) — the transaction core's create input. Names no
 *  context field (`account`, `card`, `billMonth`/`billYear`): each aggregate `.extend`s this schema
 *  with its own vocabulary (`models/creditCard.ts`, `models/account.ts`) rather than the core
 *  carrying the union and aggregates `.omit`-ing what isn't theirs. */
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

// Not a schema of its own: every real statement line is already a decoded
// ImportAccountStatementItem/ImportCardStatementItem; this is a structural subset of
// CreateTransaction, generic over both.
export type StatementLine = Pick<CreateTransaction, 'date' | 'description' | 'amount'> & { idempotencyKey?: string };

export type DefaultedStatementLine<Line extends StatementLine> = Line & {
  date: string;
  idempotencyKey: string;
  rawInput?: string;
};

/** Shared base for the aggregate-specific update tools (ADR-017), mirroring how
 *  CreateTransactionSchema is the minimal shared base for add_card_purchase/add_account_expense/
 *  add_account_income (ADR-019) — `UpdateCardTransactionSchema` (models/creditCard.ts) and
 *  `UpdateAccountTransactionSchema` (models/account.ts) `.extend` this one with their own context
 *  fields (`billMonth`/`billYear`, `account`), rather than this schema carrying them for the
 *  aggregates to `.omit`. */
export const UpdateTransactionSchema = z.object({
  id: z.string().min(1).describe('Transaction id'),
  description: z.string().min(1).optional().describe('Updated description'),
  amount: Money.optional().describe('Updated amount in full units'),
  type: MovementType.optional().describe('Updated movement type'),
  date: IsoDate.optional().describe('Updated date (YYYY-MM-DD)'),
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

/** Confirm input: flips a `pending` transaction to `effective`, optionally correcting `amount`/
 *  `date` in the same call — the only edit surface confirm exposes (reclassifying stays
 *  `update_*`'s job). Both fields are rejected on a transfer/bill-payment (`isTransfer`,
 *  `logic/transaction.ts`); a plain status-only confirm of one is still fine. */
export const ConfirmTransactionSchema = z.object({
  id: z.string().min(1).describe('Transaction id (from search_transactions with status: "pending")'),
  amount: Money.optional().describe(
    'Corrected amount, applied together with the confirm — account/card movements only, rejected for a transfer/bill-payment',
  ),
  date: IsoDate.optional().describe(
    'Corrected date (YYYY-MM-DD), applied together with the confirm — account/card movements only, rejected for a ' +
      'transfer/bill-payment; the resolved date (this, or the existing date if omitted) must not be in the future',
  ),
});
export type ConfirmTransaction = z.infer<typeof ConfirmTransactionSchema>;

/** Delete input shape (ADR-017): identical for delete_card_transaction and delete_account_transaction
 *  — delete carries zero aggregate-specific data, so unlike update it has no per-aggregate variant. */
export const DeleteTransactionSchema = z.object({
  id: z.string().min(1).describe('Transaction id'),
  confirm: z.boolean().default(false).describe('Must be true to actually delete'),
});
export type DeleteTransactionInput = z.infer<typeof DeleteTransactionSchema>;

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

/** One category node's expense spend over a period, split by status — the transactions repo's own
 *  aggregation over its own dimensions, with no knowledge of who correlates it (ADR-028).
 *  `subCategoryId` null means the row is a top-level category's own direct spend, not rolled up
 *  from a sub-category. */
export type CategorySpend = {
  currency: CurrencyCode;
  categoryId: string;
  subCategoryId: string | null;
  effective: number;
  pending: number;
};

/** One category node's effective, expense-only spend, split into a baseline/current window pair
 *  instead of `CategorySpend`'s effective/pending split — the repo's own dimensions, with no
 *  knowledge of who correlates it (ADR-028). */
export type CategoryWindowedSpend = {
  currency: CurrencyCode;
  categoryId: string;
  subCategoryId: string | null;
  current: number;
  baselineTotal: number;
};

/** Classification enriched with resolved category/merchant — returned alongside every transaction write. */
export type ClassifyOutcome = Classification & {
  categoryId?: string;
  categoryName?: string;
  merchantKey?: string;
};

/** The shared shape of "did this write land, and what does the caller need to know about it" —
 *  every insert-shaped account/credit-card flow's result. `classification` is optional: present
 *  for a movement (`add_account_expense`/`add_account_income`/`add_card_purchase` — auto/user
 *  classification is meaningful there), absent for a transfer (`create_transfer` — transfers are
 *  never classified). Named "Upsert" because from the caller's perspective, an idempotency-keyed
 *  create call means "ensure this transaction exists" — `created` distinguishes a fresh insert from
 *  a replay that found it already there. */
export type UpsertTransactionResult = {
  transaction: TransactionView;
  created: boolean;
  classification?: ClassifyOutcome;
};

/** `UpsertTransactionResult` with `classification` guaranteed present — every movement/card-purchase
 *  flow's actual return shape (`add_account_expense`/`add_account_income`/`add_card_purchase`,
 *  and bulk import, which is always one of those, never a transfer). Named once so the intersection
 *  isn't repeated at every one of those call sites. */
export type ClassifiedUpsertResult = UpsertTransactionResult & { classification: ClassifyOutcome };

export type DeleteTransactionResult =
  | { deleted: true; transaction: TransactionView }
  | { deleted: false; dryRun: true; wouldDelete: TransactionView; hint: string };

/** Shared by every aggregate's delete dry-run response (`controllers/transaction/core.ts`'s
 *  `deleteTransaction`, used by the credit-card aggregate; the account aggregate's own FC/IS
 *  `deleteAccountTransaction`, `controllers/account/transaction.ts`) — named once so the two never
 *  copy-paste the same literal (code-quality.md "constants over literals"). */
export const DELETE_TRANSACTION_CONFIRM_HINT =
  'Destructive action: show the transaction to the user and call again with confirm: true.';

/** MCP tool names for the aggregate-specific update/delete tools (ADR-017) — named once here and
 *  reused both at tool registration (diplomat/mcp/tools/{account,creditCard}.ts) and in the
 *  ownership-guard redirect hint (controllers/transaction/core.ts), rather than re-typed at each
 *  call site. */
export const TransactionTool = {
  updateCardTransaction: 'update_card_transaction',
  deleteCardTransaction: 'delete_card_transaction',
  updateAccountTransaction: 'update_account_transaction',
  deleteAccountTransaction: 'delete_account_transaction',
} as const;
export type TransactionTool = (typeof TransactionTool)[keyof typeof TransactionTool];

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
    // Phrased tool-agnostically: raised by update_card_transaction/update_account_transaction/
    // add_card_purchase (all have a `type` field a hint could name directly) as well as
    // add_account_expense/add_account_income (movement kind is the tool itself — no `type` field
    // exists to "set"), so the hint names the remedy in terms every caller can act on, not just the
    // ones with a settable field.
    hint: `Category "${categoryName}" is ${categoryKind}-only; use a matching category, or record this as ${categoryKind === 'income' ? 'income' : 'an expense'} instead`,
  }),
  exclusiveCategorySubCategory: {
    code: 'validation',
    issues: ['provide category OR subCategory, not both — subCategory implies its parent category'],
  } satisfies TransactionError,
  exclusiveCategorySubCategoryUpdate: {
    code: 'validation',
    issues: ['provide category OR subCategory, not both'],
  } satisfies TransactionError,
  invalidCursor: {
    code: 'validation',
    issues: ['cursor is malformed, stale, or does not match the requested sort/dir — start a fresh first page'],
  } satisfies TransactionError,
  // The effective ⇒ not-future-dated invariant, enforced at confirm.
  cannotConfirmFutureDated: (date: string): TransactionError => ({
    code: 'validation',
    issues: [`cannot confirm: ${date} is in the future — an effective transaction's date is never in the future`],
  }),
  confirmEditNotAllowedForTransfer: {
    code: 'validation',
    issues: [
      "cannot edit amount/date of a transfer or bill-payment transaction at confirm — correct a transfer's " +
        `amount/date via ${TransactionTool.updateAccountTransaction}, a bill payment via pay_bill/revert_bill_payment, then confirm`,
    ],
  } satisfies TransactionError,
  // ADR-017 ownership guard: raised by whichever of the four aggregate-specific update/delete tools
  // was called on a transaction it does not own — a guard, not a dispatcher (the caller re-addresses
  // the tool named in the hint; nothing here re-routes on their behalf).
  wrongTool: (correctTool: TransactionTool): TransactionError => ({
    code: 'validation',
    issues: [`this transaction is not owned by this tool; call ${correctTool} instead`],
  }),
};
