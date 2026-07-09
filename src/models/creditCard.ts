import { z } from 'zod';
import { Id } from './id.js';
import { CurrencyCode } from './money.js';
import { CreateTransactionSchema } from './transaction.js';
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

export const CreateCreditCardSchema = CreditCardSchema.omit({
  id: true,
  accountId: true,
  paymentAccountId: true,
}).extend({
  paymentAccount: z.string().min(1).optional().describe('Default paying account name for bill payment'),
});
export type CreateCreditCard = z.infer<typeof CreateCreditCardSchema>;

/** Natural input for a credit-card purchase (ADR-016): same shape as create_transaction minus
 *  `account` (the card's own internal liability account is always the destination) with `card`
 *  required instead of optional. Depends on the transaction core's schema (aggregate → core, the
 *  allowed direction) — never the reverse. `.strict()`: `account` is a meaningful field on the
 *  sibling create_transaction schema, not a server-managed one — a caller who mistakenly sends it
 *  here should get a validation error, not have it silently stripped by zod's default
 *  unknown-key behavior (REST boundary only; the MCP tool's inputSchema is a raw shape, which the
 *  MCP SDK reconstructs into its own non-strict object internally). */
export const AddCardPurchaseSchema = CreateTransactionSchema.omit({ account: true })
  .extend({
    card: z.string().min(1).describe('Credit card name — joins the cycle bill'),
  })
  .strict();
export type AddCardPurchase = z.infer<typeof AddCardPurchaseSchema>;

export type CardError = NotFound<'card'> | Ambiguous<'card'> | DuplicateName<'credit_card'> | ValidationError;

export const cardErrors = {
  duplicateName: (name: string): CardError => ({ code: 'duplicate_name', entity: 'credit_card', name }),
  currencyMismatch: (cardCurrency: CurrencyCode, accountCurrency: CurrencyCode): CardError => ({
    code: 'validation',
    issues: [`currency mismatch: card is ${cardCurrency}, payment account is ${accountCurrency}`],
  }),
};
