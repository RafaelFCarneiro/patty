import { z } from 'zod';
import { BillQuerySchema } from './bill.js';
import { Id } from './id.js';
import { CurrencyCode } from './money.js';
import {
  CreateTransactionSchema,
  STATEMENT_IDEMPOTENCY_KEY_DESCRIPTION,
  STATEMENT_ITEMS_DESCRIPTION,
  STATEMENT_RAW_INPUT_DESCRIPTION,
  UpdateTransactionSchema,
} from './transaction.js';
import type { Ambiguous, DuplicateName, NotFound, ValidationError } from './error.js';

// `.describe()` is domain information — it states what each field is and represents.
// Defaults split by intent: integrity defaults (a value that must exist for the entity to be
// valid) live here; quality-of-life convenience defaults live at the wire boundary
// (see wire/in/creditCards.ts), keeping the domain contract honest about what is required.
export const CreditCardSchema = z.object({
  id: Id,
  name: z.string().min(1).describe('Card display name'),
  currency: CurrencyCode.describe('Card currency (ISO code); fixed at creation'),
  closingDay: z
    .number()
    .int()
    .min(1)
    .max(28)
    .describe('Day the bill (fatura) closes; transactions after it go to next month'),
  dueDay: z.number().int().min(1).max(28).describe('Day the bill is due for payment'),
  limit: z.number().positive().optional().describe('Credit limit'),
  accountId: Id.describe('Internal liability account (ADR-010)'),
  paymentAccountId: Id.optional().describe('Default paying account for bill payment'),
});
export type CreditCard = z.infer<typeof CreditCardSchema>;

// The credit-card aggregate owns its own entity tag (ADR-021), mirroring `models/account.ts`'s
// `ACCOUNT_ENTITY_TAG` — `models/persistable.ts` is generic over any entity's tag/model and never
// lists this constant itself.
export const CREDIT_CARD_ENTITY_TAG = 'creditCard';

// The persistence-side entity: `CreditCard` plus the optimistic-concurrency `version` token.
// Never sent over the wire — only `deleteCreditCard` (which needs it to build a `Persistable`) and
// `adapters/creditCards.ts`'s model→row adaptation speak `CreditCardEntity`.
export const CreditCardEntitySchema = CreditCardSchema.extend({
  version: z.number().int().nonnegative().describe('Optimistic-concurrency token; internal, never on wire/out'),
});
export type CreditCardEntity = z.infer<typeof CreditCardEntitySchema>;

export const CreateCreditCardSchema = CreditCardSchema.omit({
  id: true,
  accountId: true,
  paymentAccountId: true,
}).extend({
  paymentAccount: z.string().min(1).optional().describe('Default paying account name for bill payment'),
});
export type CreateCreditCard = z.infer<typeof CreateCreditCardSchema>;

/** Natural input for a credit-card purchase (ADR-016): the transaction core's minimal
 *  `CreateTransactionSchema` (ADR-019) plus `card` (required — the card's own internal liability
 *  account is always the destination) and bill-assignment (`billMonth`/`billYear`) — both are
 *  credit-card-only vocabulary the core no longer carries. Depends on the transaction core's schema
 *  (aggregate → core, the allowed direction) — never the reverse. `.strict()`: `account` is a
 *  meaningful field on the sibling aggregate schema (`AddAccountMovementSchema`), not a
 *  server-managed one — a caller who mistakenly sends it here should get a validation error, not
 *  have it silently stripped by zod's default unknown-key behavior (REST boundary only; the MCP
 *  tool's inputSchema is a raw shape, which the MCP SDK reconstructs into its own non-strict object
 *  internally). */
export const AddCardPurchaseSchema = CreateTransactionSchema.extend({
  card: z.string().min(1).describe('Credit card name — joins the cycle bill'),
  billMonth: BillQuerySchema.shape.month
    .optional()
    .describe(
      'Explicit target bill cycle month (1-12) for a card transaction; overrides cycle-based auto-assignment. ' +
        'Provide with billYear together; requires card. Auto-creates the bill if that cycle has none yet',
    ),
  billYear: BillQuerySchema.shape.year.optional().describe('Explicit target bill cycle year; provide with billMonth'),
}).strict();
export type AddCardPurchase = z.infer<typeof AddCardPurchaseSchema>;

/** A single line of an `import_card_statement` request (ADR-017 step 2): same shape as
 *  `AddCardPurchaseSchema` minus `card` (fixed once, at the statement's top level — single-source,
 *  no per-line card) and minus `idempotencyKey`/`rawInput`/`subCategory`/`tags` (statement-level
 *  concerns: a dedup key is derived from date+description+amount when absent, `rawInput` belongs to
 *  the whole pasted statement, and bulk import classifies automatically rather than taking a
 *  sub-category or tags per line — the same reduced shape the retired god bulk item carried). */
export const ImportCardStatementItemSchema = AddCardPurchaseSchema.omit({
  card: true,
  idempotencyKey: true,
  rawInput: true,
  subCategory: true,
  tags: true,
})
  .extend({
    idempotencyKey: AddCardPurchaseSchema.shape.idempotencyKey
      .optional()
      .describe(STATEMENT_IDEMPOTENCY_KEY_DESCRIPTION),
  })
  .strict();
export type ImportCardStatementItem = z.infer<typeof ImportCardStatementItemSchema>;

/** Credit-card statement import (ADR-017 step 2): single-source — every item is a purchase on the
 *  ONE card named here, joining each line's own cycle bill via `addCardPurchase`. Replaces the god
 *  `create_transactions_bulk`'s per-line card routing entirely (a statement can't carry a
 *  conflicting per-line owner by construction). */
export const ImportCardStatementSchema = z.object({
  card: z.string().min(1).describe('Credit card name — every item in this statement is a purchase on this one card'),
  items: z.array(ImportCardStatementItemSchema).min(1).max(200).describe(STATEMENT_ITEMS_DESCRIPTION),
  rawInput: z.string().optional().describe(STATEMENT_RAW_INPUT_DESCRIPTION),
});
export type ImportCardStatement = z.infer<typeof ImportCardStatementSchema>;

/** Card-aggregate update schema (ADR-017/ADR-019): `.extend`s the core's minimal
 *  `UpdateTransactionSchema` with `account` — kept reachable (not omitted) so it can be explicitly
 *  rejected with a helpful message (`cardErrors.accountChangeRejectedForCard`) rather than a generic
 *  `.strict()` unrecognized-key error — and `billMonth`/`billYear`, genuine card-only reassignment
 *  vocabulary. `.strict()` still rejects truly foreign fields at the REST boundary (MCP tool args
 *  are reconstructed as a non-strict shape by the SDK). */
export const UpdateCardTransactionSchema = UpdateTransactionSchema.extend({
  account: z
    .string()
    .min(1)
    .optional()
    .describe(
      "Rejected: a card transaction is always funded by the card's own internal account. Sending this " +
        'field returns a validation error rather than reassigning it — present only so that error can be ' +
        'raised, not because the account is changeable',
    ),
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
}).strict();
export type UpdateCardTransaction = z.infer<typeof UpdateCardTransactionSchema>;

export type CardError = NotFound<'card'> | Ambiguous<'card'> | DuplicateName<'credit_card'> | ValidationError;

export const cardErrors = {
  duplicateName: (name: string): CardError => ({ code: 'duplicate_name', entity: 'credit_card', name }),
  currencyMismatch: (cardCurrency: CurrencyCode, accountCurrency: CurrencyCode): CardError => ({
    code: 'validation',
    issues: [`currency mismatch: card is ${cardCurrency}, payment account is ${accountCurrency}`],
  }),
  // Field-tied to billMonth/billYear (ADR-019 step 1: moved from models/transaction.ts's
  // transactionErrors, where the core used to raise them itself — the core no longer carries these
  // fields at all, so only the credit-card aggregate, which owns them, can raise these now).
  billPeriodIncomplete: {
    code: 'validation',
    issues: ['billMonth and billYear must be provided together'],
  } satisfies CardError,
  billAssignmentRequiresCard: {
    code: 'validation',
    issues: [
      'billMonth/billYear require a credit-card transaction; provide `card` (create) or the transaction must already have one (update)',
    ],
  } satisfies CardError,
  paidBillImmutable: {
    code: 'validation',
    issues: [
      'this bill is paid; its transactions cannot be added, removed, or reassigned — call revert_bill_payment first',
    ],
  } satisfies CardError,
  accountChangeRejectedForCard: {
    code: 'validation',
    issues: ["cannot change the account of a card transaction; it is always funded by the card's own internal account"],
  } satisfies CardError,
};
