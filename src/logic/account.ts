import { err, ok, type Result } from 'neverthrow';
import { purry } from 'remeda';
import { localizeAccountType } from './localize.js';
import { accountErrors, AccountType } from '../models/account.js';
import type { Account, AccountError, AccountReferences } from '../models/account.js';
import type { Locale } from '../models/locale.js';
import { TransactionType } from '../models/transaction.js';
import type { TransactionView, UpdateTransaction } from '../models/transaction.js';
import { isTransfer } from './transaction.js';

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
  return purry(_withTypeLabel, args);
}
