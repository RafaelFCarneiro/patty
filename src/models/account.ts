import { z } from 'zod';
import { Id } from './id.js';
import { ConvertedValueSchema } from './currency-rate.js';
import { CurrencyCode, Money } from './money.js';
import { IsoDate } from './date.js';
import { withPersistenceMeta } from '@rfc0/effect-runner';
import {
  CreateTransactionSchema,
  DISCRIMINATOR_DESCRIPTION,
  STATEMENT_ITEMS_DESCRIPTION,
  STATEMENT_RAW_INPUT_DESCRIPTION,
  TransactionStatus,
  UpdateTransactionSchema,
  type TransactionEntity,
  type TransactionSource,
} from './transaction.js';
import {
  validationWithRemedy,
  type Ambiguous,
  type DuplicateName,
  type InUse,
  type NotFound,
  type ValidationError,
} from './error.js';
import { Remedy } from './remedy.js';
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

// The persistence-side entity (docs/canonical/functional-core-imperative-shell.md): `Account` plus
// the optimistic-concurrency `version` token. Never sent over the wire — kept off `AccountSchema`
// itself so every existing account-returning flow (which reuses `AccountSchema` as its wire/out
// shape) stays unchanged. Only flows that build `Persistable`s and `adapters/accounts.ts`'s
// model→row adaptation (`modelToDb`/`persistableToDb`) speak `AccountEntity` — the applier itself
// doesn't: by the time a batch reaches `diplomat/db`, it's already been adapted to a plain row
// (`versionedTableApplier` in `diplomat/db/effects.ts` is entity-agnostic).
export const AccountEntitySchema = withPersistenceMeta(AccountSchema);
export type AccountEntity = z.infer<typeof AccountEntitySchema>;

// The account aggregate owns its own entity tag — `@rfc0/effect-runner`'s `Persistable` is generic over any
// entity's tag/model and never lists this constant itself, so adding a new converted aggregate
// never means editing that shared file.
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
  converted: ConvertedValueSchema.optional().describe(
    'Read-time valuation of balance in the base currency (ADR-026); absent when no exchange rate is on file',
  ),
});
export type AccountBalance = z.infer<typeof AccountBalanceSchema>;

export const ConsolidatedNetWorthSchema = z.object({
  baseCurrency: CurrencyCode.describe('The base currency all included balances are summed in'),
  total: z.number().describe('Sum of every included balance converted value'),
  excluded: z
    .array(Id)
    .describe('Account ids left out of total because no exchange rate is on file for their currency'),
});
export type ConsolidatedNetWorth = z.infer<typeof ConsolidatedNetWorthSchema>;

export const AccountBalancesResultSchema = z.object({
  balances: z.array(AccountBalanceSchema),
  consolidatedNetWorth: ConsolidatedNetWorthSchema,
});
export type AccountBalancesResult = z.infer<typeof AccountBalancesResultSchema>;

/** Natural input for an account expense/income: the transaction core's minimal
 *  `CreateTransactionSchema` plus `account`, minus `type` (the movement kind is the tool
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

/** A single line of an `import_account_statement` request: the transaction core's minimal
 *  `CreateTransactionSchema` minus `rawInput`/`subCategory`/`tags` (statement-level concerns) — no
 *  `account` (fixed once, at the statement's top level — single-source, no per-line account) and no
 *  `card`/`billMonth`/`billYear` (card/bill-assignment vocabulary the core never carries). Unlike
 *  `AddAccountMovementSchema`, `type` stays required — a statement line still needs its own
 *  expense-vs-income marker, since the movement kind isn't fixed by which tool was called. */
export const ImportAccountStatementItemSchema = CreateTransactionSchema.omit({
  rawInput: true,
  subCategory: true,
  tags: true,
}).strict();
export type ImportAccountStatementItem = z.infer<typeof ImportAccountStatementItemSchema>;

/** Account statement import: single-source — every item is an expense or income (per item's
 *  `type`) on the ONE account named here (omit for unattached, e.g. cash, movements), via
 *  `addAccountExpense`/`addAccountIncome`. A statement can't carry a conflicting per-line owner
 *  by construction. */
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

/** Account-aggregate update schema: `.extend`s the core's minimal `UpdateTransactionSchema` with
 *  `account` — the core no longer carries bill-assignment (`billMonth`/`billYear`) at all, so it
 *  structurally can't reach this schema (mirrors `AddAccountMovementSchema`'s create-side shape).
 *  `.strict()`: same REST-boundary-only reasoning as `AddAccountMovementSchema` above. */
export const UpdateAccountTransactionSchema = UpdateTransactionSchema.extend({
  account: z.string().min(1).optional().describe('New account name'),
}).strict();
export type UpdateAccountTransaction = z.infer<typeof UpdateAccountTransactionSchema>;

/** Natural input for a transfer: account-context vocabulary — a transfer request is an
 *  account-aggregate concern even though it persists as a transaction row via the shared core
 *  primitive (account → core, the allowed direction). `.strict()`: same REST-boundary-only
 *  reasoning as `AddAccountMovementSchema` above. */
export const CreateTransferSchema = z
  .object({
    from: z.string().min(1).describe('Source account name'),
    to: z.string().min(1).describe('Destination account name'),
    amount: Money.describe('Transfer amount in full units'),
    status: TransactionStatus.optional().describe('pending | effective; omit for date-aware default'),
    date: IsoDate.optional().describe('YYYY-MM-DD; defaults to today'),
    description: z.string().optional().describe('e.g. "aporte mensal"'),
    discriminator: z.string().min(1).optional().describe(DISCRIMINATOR_DESCRIPTION),
  })
  .strict();
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

const CREDIT_REJECTED_MESSAGE = 'credit accounts are managed by their credit card — use the card flow instead';
const creditTransferFromMessage = (name: string): string =>
  `cannot transfer from a credit account (${name}) — pay the card's bill instead`;
const creditTransferToMessage = (name: string): string =>
  `cannot transfer to a credit account (${name}) — pay the card's bill instead`;

export const accountErrors = {
  creditRejected: (remedy: Remedy): AccountError => validationWithRemedy(CREDIT_REJECTED_MESSAGE, remedy),
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
  creditTransferFromRejected: (name: string): AccountError =>
    validationWithRemedy(creditTransferFromMessage(name), Remedy.enum.pay_bill),
  creditTransferToRejected: (name: string): AccountError =>
    validationWithRemedy(creditTransferToMessage(name), Remedy.enum.pay_bill),
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
  // Transfer mutation policy: only the account aggregate's update ever reaches a mutable transfer
  // (the credit-card aggregate's only transfer, the bill-payment transfer, is blocked outright by
  // its own bill-process guard, never by these).
  transferTypeImmutable: {
    code: 'validation',
    issues: ['cannot change the type of a transfer transaction'],
  } satisfies AccountError,
  transferCategoryRejected: {
    code: 'validation',
    issues: ['transfer transactions cannot have a category or sub-category'],
  } satisfies AccountError,
};

export type TransferFacts = {
  id: string;
  today: string;
  input: CreateTransfer;
  from: Pick<Account, 'id' | 'name' | 'currency'>;
  to: Pick<Account, 'id' | 'name'>;
  source: TransactionSource;
  decimals: number;
};

export type TransferPlan = { entity: TransactionEntity; idempotencyKey: string };

export const ACCOUNT_OWNED_TYPES: ReadonlySet<AccountType> = new Set([
  AccountType.enum.checking,
  AccountType.enum.savings,
  AccountType.enum.wallet,
  AccountType.enum.investment,
]);

export type BalanceParts = {
  initialBalance: number;
  income: number;
  expenses: number;
  transfersIn: number;
  transfersOut: number;
};

export type PendingParts = Omit<BalanceParts, 'initialBalance'>;
