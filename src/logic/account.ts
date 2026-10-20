import { err, ok, type Result } from 'neverthrow';
import * as R from 'remeda';
import { localizeAccountType } from './localize.js';
import {
  accountErrors,
  AccountType,
  type Account,
  type AccountEntity,
  type AccountError,
  type AccountReferences,
  type TransferFacts,
  type TransferPlan,
  type UpdateAccount,
  ACCOUNT_OWNED_TYPES,
} from '../models/account.js';
import type { Locale } from '../models/locale.js';
import {
  UNCLASSIFIED,
  TransactionType,
  type TransactionEntity,
  type TransactionView,
  type UpdateTransaction,
} from '../models/transaction.js';
import { defaultStatusFor, deriveIdempotencyKey, isTransfer } from './transaction.js';

export const filterByType =
  (type?: AccountType) =>
  (a: Account): boolean =>
    !type || a.type === type;

export const assertNonCreditType = (type?: AccountType): boolean => type !== AccountType.enum.credit;

export const hasNoTransactions = (refs: AccountReferences): boolean => refs.transactions === 0;
export const hasNoRecurring = (refs: AccountReferences): boolean => refs.recurring === 0;
export const hasNoCards = (refs: AccountReferences): boolean => refs.cards === 0;
export const isUnreferenced = (refs: AccountReferences): boolean =>
  hasNoTransactions(refs) && hasNoRecurring(refs) && hasNoCards(refs);

export const isRename = (currentName: string, newName?: string): newName is string =>
  newName !== undefined && newName.toLowerCase() !== currentName.toLowerCase();

export const changesPinnedField = (input: Pick<UpdateAccount, 'type' | 'currency'>): boolean =>
  R.isDefined(input.type) || R.isDefined(input.currency);

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

export const isAccountOwnedType = (type: AccountType): boolean => ACCOUNT_OWNED_TYPES.has(type);

const wouldBeTransfer = (existing: Pick<TransactionView, 'type'>, input: Pick<UpdateTransaction, 'type'>) =>
  (input.type ?? existing.type) === TransactionType.enum.transfer;
const hasCategoryInput = (input: Pick<UpdateTransaction, 'category' | 'subCategory'>) =>
  !!(input.category || input.subCategory);

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
    classification: UNCLASSIFIED,
    refs: { accountId: from.id, toAccountId: to.id },
  };
  const idempotencyKey = deriveIdempotencyKey(
    {
      fundingSourceId: from.id,
      counterpartyId: to.id,
      type: entity.type,
      currency: entity.currency,
      date,
      // Not entity.description: its placeholder embeds account names, so a rename would miss a real duplicate.
      description: input.description ?? '',
      amount: entity.amount,
    },
    facts.decimals,
    input.discriminator,
  );
  return { entity, idempotencyKey };
};
