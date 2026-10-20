import { err, ok, type Result } from 'neverthrow';
import * as R from 'remeda';
import { localizeAccountType } from './localize.js';
import { accountErrors, AccountType } from '../models/account.js';
import type {
  Account,
  AccountEntity,
  AccountError,
  AccountReferences,
  CreateTransfer,
  UpdateAccount,
} from '../models/account.js';
import type { Locale } from '../models/locale.js';
import { ClassificationMethod, TransactionType } from '../models/transaction.js';
import type {
  TransactionEntity,
  TransactionSource,
  TransactionView,
  UpdateTransaction,
} from '../models/transaction.js';
import { defaultStatusFor, deriveIdempotencyKey, isTransfer } from './transaction.js';

export const filterByType =
  (type?: AccountType) =>
  (a: Account): boolean =>
    !type || a.type === type;

/**
 * Manual create/update may not target credit accounts — those are card-managed.
 * Pure guard condition (no I/O): `guard(assertNonCreditType(type), accountErrors.creditRejected)`.
 * `undefined` passes — an omitted type on update is not a credit assignment.
 */
export const assertNonCreditType = (type?: AccountType): boolean => type !== AccountType.enum.credit;

// Reference predicates — pure interpretations of AccountReferences, paired with `guard` at call sites.
// Each reads as the precondition that must hold (true = the change is allowed).
export const hasNoTransactions = (refs: AccountReferences): boolean => refs.transactions === 0;
export const hasNoRecurring = (refs: AccountReferences): boolean => refs.recurring === 0;
export const hasNoCards = (refs: AccountReferences): boolean => refs.cards === 0;
export const isUnreferenced = (refs: AccountReferences): boolean =>
  hasNoTransactions(refs) && hasNoRecurring(refs) && hasNoCards(refs);

/** Case-insensitive, so a case-only change ("itau" → "Itau") is not a rename — gates the
 *  name-availability guard, which would otherwise collide with the account's own current name. */
export const isRename = (currentName: string, newName?: string): newName is string =>
  newName !== undefined && newName.toLowerCase() !== currentName.toLowerCase();

/** True when an update touches a field the account's history pins (its type or currency). */
export const changesPinnedField = (input: Pick<UpdateAccount, 'type' | 'currency'>): boolean =>
  R.isDefined(input.type) || R.isDefined(input.currency);

/** Refuses changing the type or currency once the account has activity: the first violated rule wins. */
export const guardPinnedFields = (
  refs: AccountReferences,
  input: Pick<UpdateAccount, 'type' | 'currency'>,
): Result<void, AccountError> => {
  const isChangingType = R.isDefined(input.type);
  const isChangingCurrency = R.isDefined(input.currency);
  const violations: ReadonlyArray<readonly [boolean, AccountError]> = [
    [isChangingType && !hasNoTransactions(refs), accountErrors.typeImmutable(refs.transactions)],
    [isChangingCurrency && !hasNoTransactions(refs), accountErrors.currencyImmutableTransactions(refs.transactions)],
    [isChangingCurrency && !hasNoRecurring(refs), accountErrors.currencyImmutableRecurring],
    [isChangingCurrency && !hasNoCards(refs), accountErrors.currencyImmutableCards],
  ];
  const violated = R.find(violations, ([isViolated]) => isViolated);
  return violated ? err(violated[1]) : ok(undefined);
};

/** The account with every provided patch field laid over it. */
export const mergeAccountPatch = (raw: AccountEntity, input: UpdateAccount): AccountEntity => ({
  ...raw,
  name: input.newName ?? raw.name,
  initialBalance: input.initialBalance ?? raw.initialBalance,
  type: input.type ?? raw.type,
  currency: input.currency ?? raw.currency,
});

export const areDifferentAccounts = (a: Pick<Account, 'id'>, b: Pick<Account, 'id'>): boolean => a.id !== b.id;

export const assertCurrencyMatch = (a: Pick<Account, 'currency'>, b: Pick<Account, 'currency'>): boolean =>
  a.currency === b.currency;

/**
 * The account aggregate's own types (ADR-020) — a positive enumeration of what it owns, not the
 * negation of what it doesn't (`assertNonCreditType` above answers a different question: "is this
 * one specific type disallowed", asked by create/update/payment/transfer-leg guards). Ownership
 * resolution wants "is this among the types I own", so it's defined here directly rather than by
 * excluding `credit` — the account domain shouldn't have to name the credit-card domain's type to
 * describe its own scope.
 */
const ACCOUNT_OWNED_TYPES: ReadonlySet<AccountType> = new Set([
  AccountType.enum.checking,
  AccountType.enum.savings,
  AccountType.enum.wallet,
  AccountType.enum.investment,
]);

export const isAccountOwnedType = (type: AccountType): boolean => ACCOUNT_OWNED_TYPES.has(type);

// ─── Transfer mutability guard (ADR-020 §4) ──────────────────────────────────
// Only the account aggregate ever mutates a regular transfer — the credit-card aggregate's one
// transfer (the bill-payment transfer) is blocked outright by its own bill-process guard and never
// reaches this check.

const wouldBeTransfer = (existing: Pick<TransactionView, 'type'>, input: Pick<UpdateTransaction, 'type'>) =>
  (input.type ?? existing.type) === TransactionType.enum.transfer;
const hasCategoryInput = (input: Pick<UpdateTransaction, 'category' | 'subCategory'>) =>
  !!(input.category || input.subCategory);

/**
 * Enforce transfer invariants on update:
 * - A transfer's type cannot be changed.
 * - A transfer cannot receive a category or sub-category.
 */
export const guardTransferMutability = (
  existing: Pick<TransactionView, 'type'>,
  input: Pick<UpdateTransaction, 'type' | 'category' | 'subCategory'>,
): Result<void, AccountError> => {
  if (isTransfer(existing) && input.type) return err(accountErrors.transferTypeImmutable);
  if (wouldBeTransfer(existing, input) && hasCategoryInput(input)) return err(accountErrors.transferCategoryRejected);
  return ok(undefined);
};

const _withTypeLabel = <T extends Account>(account: T, locale: Locale): T => ({
  ...account,
  typeLabel: localizeAccountType(account.type, locale),
});

export function withTypeLabel<T extends Account>(account: T, locale: Locale): T;
export function withTypeLabel(locale: Locale): <T extends Account>(account: T) => T;
export function withTypeLabel(...args: readonly unknown[]) {
  return R.purry(_withTypeLabel, args);
}

// ─── Transfer plan ───────────────────────────────────────────────────────────

export type TransferFacts = {
  /** Minted by the controller (`deps.newId()`) — logic never draws ids. */
  id: string;
  today: string;
  input: CreateTransfer;
  from: Pick<Account, 'id' | 'name' | 'currency'>;
  to: Pick<Account, 'id' | 'name'>;
  source: TransactionSource;
  /** The currency's own decimals, for rounding the amount inside the idempotency key. */
  decimals: number;
};

export type TransferPlan = { entity: TransactionEntity; idempotencyKey: string };

/** Decides a transfer from the values its controller gathered. Never classified, so no category or
 *  merchant: a transfer debits FROM and credits TO and stays out of spending summaries (ADR-002). */
export const planTransfer = (facts: TransferFacts): TransferPlan => {
  const { input, from, to } = facts;
  const date = input.date ?? facts.today;
  const entity: TransactionEntity = {
    id: facts.id,
    description: input.description ?? `Transferência: ${from.name} → ${to.name}`,
    amount: input.amount,
    type: TransactionType.enum.transfer,
    status: input.status ?? defaultStatusFor(date, facts.today),
    date,
    currency: from.currency,
    source: facts.source,
    classification: { method: ClassificationMethod.enum.none, confidence: 0 },
    refs: { accountId: from.id, toAccountId: to.id },
  };
  const idempotencyKey = deriveIdempotencyKey(
    {
      fundingSourceId: from.id,
      counterpartyId: to.id,
      type: entity.type,
      currency: entity.currency,
      date,
      // input.description, not entity.description — the latter falls back to a display-name-
      // based placeholder, which would change (and so silently miss a real duplicate) if either
      // account was renamed between calls.
      description: input.description ?? '',
      amount: entity.amount,
    },
    facts.decimals,
    input.discriminator,
  );
  return { entity, idempotencyKey };
};
