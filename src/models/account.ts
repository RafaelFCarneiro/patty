import { z } from 'zod';
import { Id } from './id.js';
import { CurrencyCode, Money } from './money.js';
import { IsoDate } from './date.js';
import {
  CreateTransactionSchema,
  STATEMENT_IDEMPOTENCY_KEY_DESCRIPTION,
  STATEMENT_ITEMS_DESCRIPTION,
  STATEMENT_RAW_INPUT_DESCRIPTION,
  TransactionStatus,
  UpdateTransactionSchema,
} from './transaction.js';
import type { Ambiguous, DuplicateName, InUse, NotFound, ValidationError } from './error.js';
import type { LabelMap } from './locale.js';

export const AccountType = z.enum(['checking', 'savings', 'wallet', 'investment', 'credit']);
export type AccountType = z.infer<typeof AccountType>;

export const accountTypeLabels: LabelMap<AccountType> = {
  checking: { en: 'Checking', pt: 'Conta corrente', es: 'Cuenta corriente' },
  savings: { en: 'Savings', pt: 'Poupança', es: 'Ahorros' },
  wallet: { en: 'Wallet', pt: 'Carteira', es: 'Billetera' },
  investment: { en: 'Investment', pt: 'Investimentos', es: 'Inversiones' },
  credit: { en: 'Credit card', pt: 'Cartão de crédito', es: 'Tarjeta de crédito' },
};

// `.describe()` is domain information — it states what each field is and represents.
// Defaults split by intent: integrity defaults (a value that must exist for the entity to be
// valid, e.g. initialBalance → 0) live here; quality-of-life convenience defaults live at the
// wire boundary (see wire/in/accounts.ts), keeping the domain contract honest about what is required.
export const AccountSchema = z.object({
  id: Id,
  name: z.string().min(1).describe('Account name'),
  type: AccountType.describe('checking | savings | wallet | investment (credit is card-managed)'),
  typeLabel: z.string().optional(),
  currency: CurrencyCode.describe('Account currency (ISO code); fixed once the account has activity'),
  initialBalance: z.number().default(0).describe('Balance at account creation; current balance is always derived'),
});
export type Account = z.infer<typeof AccountSchema>;

// The persistence-side entity (ADR-021 / functional-core-imperative-shell.md): `Account` plus
// the optimistic-concurrency `version` token. Never sent over the wire — kept off `AccountSchema`
// itself so every existing account-returning flow (which reuses `AccountSchema` as its wire/out
// shape) stays unchanged. Only flows that build `Persistable`s and `adapters/accounts.ts`'s
// model→row adaptation (`modelToDb`/`persistableToDb`) speak `AccountEntity` — the unit-of-work
// applier itself doesn't: by the time a batch reaches `diplomat/db`, it's already been adapted to
// a plain row (`versionedTableApplier` in `diplomat/db/unitOfWork.ts` is entity-agnostic).
export const AccountEntitySchema = AccountSchema.extend({
  version: z.number().int().nonnegative().describe('Optimistic-concurrency token; internal, never on wire/out'),
});
export type AccountEntity = z.infer<typeof AccountEntitySchema>;

// The account aggregate owns its own entity tag (ADR-021) — `models/persistable.ts` is generic
// over any entity's tag/model and never lists this constant itself, so adding a new converted
// aggregate never means editing that shared file. `logic/persistence.ts`'s `Persistable` builders
// take it as a plain field value; `main.ts` keys the `ApplierRegistry` by it when registering
// `diplomat/db/repos/accounts.ts`'s `accountApplier`.
export const ACCOUNT_ENTITY_TAG = 'account';

export const CreateAccountSchema = AccountSchema.omit({ id: true, typeLabel: true });
export type CreateAccount = z.infer<typeof CreateAccountSchema>;

export const UpdateAccountSchema = AccountSchema.omit({ id: true, typeLabel: true })
  .partial({ initialBalance: true, type: true, currency: true })
  .extend({ newName: z.string().min(1).optional().describe('New account name') });
export type UpdateAccount = z.infer<typeof UpdateAccountSchema>;

export const AccountBalanceSchema = AccountSchema.extend({
  balance: z.number(),
  income: z.number(),
  expenses: z.number(),
  transfersIn: z.number(),
  transfersOut: z.number(),
  projectedBalance: z.number().optional().describe('Effective balance + pending through projectedAsOf, if supplied'),
});
export type AccountBalance = z.infer<typeof AccountBalanceSchema>;

/** Natural input for an account expense/income (ADR-016): the transaction core's minimal
 *  `CreateTransactionSchema` (ADR-019) plus `account`, minus `type` (the movement kind is the tool
 *  itself — `add_account_expense` vs. `add_account_income` — not a field; card/bill-assignment
 *  vocabulary never reaches this schema at all, since the core no longer carries it). `account`
 *  stays optional: an omitted account records an unattached (e.g. cash) movement. Depends on the
 *  transaction core's schema (aggregate → core, the allowed direction) — never the reverse.
 *  `.strict()`: `card`/`type`/`billMonth`/`billYear` are meaningful fields on the sibling aggregate
 *  schema (`AddCardPurchaseSchema`), not server-managed ones — a caller who mistakenly sends them
 *  here should get a validation error, not have them silently stripped by zod's default unknown-key
 *  behavior (REST boundary only; the MCP tool's inputSchema is a raw shape, which the MCP SDK
 *  reconstructs into its own non-strict object internally). */
export const AddAccountMovementSchema = CreateTransactionSchema.extend({
  account: z.string().min(1).optional().describe('Account name, e.g. "Nubank"'),
})
  .omit({ type: true })
  .strict();
export type AddAccountMovement = z.infer<typeof AddAccountMovementSchema>;

/** A single line of an `import_account_statement` request (ADR-017 step 2): the transaction core's
 *  minimal `CreateTransactionSchema` (ADR-019) minus `idempotencyKey`/`rawInput`/`subCategory`/`tags`
 *  (statement-level concerns, same reduced shape the retired god bulk item carried) — no `account`
 *  (fixed once, at the statement's top level — single-source, no per-line account) and no
 *  `card`/`billMonth`/`billYear` (card/bill-assignment vocabulary the core never carries). Unlike
 *  `AddAccountMovementSchema`, `type` stays required — a statement line still needs its own
 *  expense-vs-income discriminator, since (unlike `add_account_expense`/`add_account_income`) the
 *  movement kind isn't fixed by which tool was called. */
export const ImportAccountStatementItemSchema = CreateTransactionSchema.omit({
  idempotencyKey: true,
  rawInput: true,
  subCategory: true,
  tags: true,
})
  .extend({
    idempotencyKey: CreateTransactionSchema.shape.idempotencyKey
      .optional()
      .describe(STATEMENT_IDEMPOTENCY_KEY_DESCRIPTION),
  })
  .strict();
export type ImportAccountStatementItem = z.infer<typeof ImportAccountStatementItemSchema>;

/** Account statement import (ADR-017 step 2): single-source — every item is an expense or income
 *  (per item's `type`) on the ONE account named here (omit for unattached, e.g. cash, movements),
 *  via `addAccountExpense`/`addAccountIncome`. Replaces the god `create_transactions_bulk`'s
 *  per-line account-vs-card routing entirely (a statement can't carry a conflicting per-line owner
 *  by construction). */
export const ImportAccountStatementSchema = z.object({
  account: z
    .string()
    .min(1)
    .optional()
    .describe(
      'Account name — every item in this statement belongs to this one account; omit for unattached (e.g. cash) movements',
    ),
  items: z.array(ImportAccountStatementItemSchema).min(1).max(200).describe(STATEMENT_ITEMS_DESCRIPTION),
  rawInput: z.string().optional().describe(STATEMENT_RAW_INPUT_DESCRIPTION),
});
export type ImportAccountStatement = z.infer<typeof ImportAccountStatementSchema>;

/** Account-aggregate update schema (ADR-017/ADR-019): `.extend`s the core's minimal
 *  `UpdateTransactionSchema` with `account` — the core no longer carries bill-assignment
 *  (`billMonth`/`billYear`) at all, so unlike before there is nothing left to omit; it structurally
 *  can't reach this schema (mirrors `AddAccountMovementSchema`'s create-side shape). `.strict()`:
 *  same REST-boundary-only reasoning as `AddAccountMovementSchema` above. */
export const UpdateAccountTransactionSchema = UpdateTransactionSchema.extend({
  account: z.string().min(1).optional().describe('New account name'),
}).strict();
export type UpdateAccountTransaction = z.infer<typeof UpdateAccountTransactionSchema>;

/** Natural input for a transfer (ADR-016 step 4): account-context vocabulary — a transfer request
 *  is an account-aggregate concern even though it persists as a transaction row via the shared core
 *  primitive (account → core, the allowed direction). Moved here from models/transaction.ts, which
 *  never had a `createTransfer` entry point of its own. */
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

/**
 * What counts as a reference to an account — the domain's definition of what blocks
 * destructive/structural changes (delete, type/currency edits). The repo populates the counts;
 * `logic/account.ts` predicates interpret them.
 */
export type AccountReferences = { transactions: number; recurring: number; cards: number };

export type AccountError =
  | NotFound<'account'>
  | Ambiguous<'account'>
  | DuplicateName<'account'>
  | InUse<'account', AccountReferences>
  | ValidationError;

export const accountErrors = {
  creditRejected: {
    code: 'validation',
    issues: [
      'credit accounts are managed by their credit card — use the card flow instead (create_credit_card / delete_credit_card)',
    ],
  } satisfies AccountError,
  duplicateName: (name: string): AccountError => ({ code: 'duplicate_name', entity: 'account', name }),
  inUse: (name: string, references: AccountReferences): AccountError => ({
    code: 'in_use',
    entity: 'account',
    name,
    references,
  }),
  typeImmutable: (transactions: number): AccountError => ({
    code: 'validation',
    issues: [`type cannot be changed — account has ${transactions} transaction(s)`],
  }),
  currencyImmutableTransactions: (transactions: number): AccountError => ({
    code: 'validation',
    issues: [`currency cannot be changed — account has ${transactions} transaction(s)`],
  }),
  currencyImmutableRecurring: {
    code: 'validation',
    issues: ['currency cannot be changed — account has recurring rules that persist the original currency'],
  } satisfies AccountError,
  currencyImmutableCards: {
    code: 'validation',
    issues: ['currency cannot be changed — account is a credit card payment account'],
  } satisfies AccountError,
  creditPostRejected: {
    code: 'validation',
    issues: ['cannot post directly to a credit account — use the card parameter instead'],
  } satisfies AccountError,
  creditTransferFromRejected: (name: string): AccountError => ({
    code: 'validation',
    issues: [`cannot transfer from a credit account (${name}) — use pay_bill instead`],
  }),
  creditTransferToRejected: (name: string): AccountError => ({
    code: 'validation',
    issues: [`cannot transfer to a credit account (${name}) — use pay_bill instead`],
  }),
  creditPaymentRejected: {
    code: 'validation',
    issues: ['payment account cannot be a credit account'],
  } satisfies AccountError,
  currencyMismatch: (cardCurrency: CurrencyCode, payerCurrency: CurrencyCode): AccountError => ({
    code: 'validation',
    issues: [`currency mismatch: card is ${cardCurrency}, payer is ${payerCurrency}`],
  }),
  sameAccount: {
    code: 'validation',
    issues: ['from and to must be different accounts'],
  } satisfies AccountError,
  crossCurrencyTransfer: (
    from: Pick<Account, 'name' | 'currency'>,
    to: Pick<Account, 'name' | 'currency'>,
  ): AccountError => ({
    code: 'validation',
    issues: [
      `cross-currency transfer not supported yet: ${from.name} is ${from.currency}, ${to.name} is ${to.currency}`,
    ],
  }),
  // Transfer mutation policy (ADR-020 §4) — moved from transactionErrors: only the account
  // aggregate's update ever reaches a mutable transfer (the credit-card aggregate's only transfer,
  // the bill-payment transfer, is blocked outright by its own bill-process guard, never by these).
  transferTypeImmutable: {
    code: 'validation',
    issues: ['cannot change the type of a transfer transaction'],
  } satisfies AccountError,
  transferCategoryRejected: {
    code: 'validation',
    issues: ['transfer transactions cannot have a category or sub-category'],
  } satisfies AccountError,
};
