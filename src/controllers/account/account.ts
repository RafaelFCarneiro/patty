import { ok, safeTry, type ResultAsync } from 'neverthrow';
import * as R from 'remeda';
import type { AppError } from '../../common/errors.js';
import { guard, okOr } from '../../common/result.js';
import {
  assertNonCreditType,
  filterByType,
  hasNoCards,
  hasNoRecurring,
  hasNoTransactions,
  isUnreferenced,
  withTypeLabel,
} from '../../logic/account.js';
import { computeBalance, computeProjectedBalance } from '../../logic/balance.js';
import { consolidateNetWorth, valueAccount } from '../../logic/currencyRate.js';
import { resolveBaseCurrency } from '../../logic/locale.js';
import { decimalsLookup } from '../../logic/money.js';
import * as persistence from '../../logic/persistence.js';
import { resolveByName } from '../../logic/resolve.js';
import { accountErrors, ACCOUNT_ENTITY_TAG } from '../../models/account.js';
import type {
  Account,
  AccountBalance,
  AccountBalancesResult,
  AccountEntity,
  AccountType,
  CreateAccount,
  UpdateAccount,
} from '../../models/account.js';
import { notFound } from '../../models/error.js';
import { Locale } from '../../models/locale.js';
import type { FlowOutcome, Persistable } from '@rafaelfcarneiro/effect-runner';
import type { Deps } from '../deps.js';
import { resolveAccountRef, resolutionToResult } from '../resolve.js';

/** Repo-touching precondition: true when no account already holds this name. */
const assertNameAvailable = async (deps: Deps, name: string): Promise<boolean> =>
  !(await deps.accounts.findByName(name));

export const listAccounts = async (deps: Deps, type?: AccountType): Promise<Account[]> => {
  const [locale, all] = await Promise.all([deps.locale(), deps.accounts.list()]);
  return R.pipe(all, R.filter(filterByType(type)), R.map(withTypeLabel(locale)));
};

/** A functional-core flow (docs/functional-core-imperative-shell.md): decides and returns the
 *  write as data (`persist`) instead of performing it; the imperative shell adapts and applies
 *  the batch and returns `response`. A new account has no `version` to decide — that's the
 *  shell's own structural constant (`INITIAL_VERSION`) — so the model built here, and the
 *  response, are both the plain wire-shaped `Account`. */
export const createAccount = (deps: Deps, input: CreateAccount): ResultAsync<FlowOutcome<Account>, AppError> =>
  safeTry(async function* () {
    yield* guard(assertNonCreditType(input.type), accountErrors.creditRejected);
    yield* guard(await assertNameAvailable(deps, input.name), accountErrors.duplicateName(input.name));

    const account: Account = { id: deps.newId(), ...input };
    const persist: Persistable[] = [persistence.insert({ entity: ACCOUNT_ENTITY_TAG, model: account })];
    return ok({ persist, response: account });
  });

/** Balances are derived: initialBalance + income − expenses + transfers in − transfers out.
 *  Valuation against the base currency (ADR-026) correlates the `accounts` and `currency_rates`
 *  aggregates here, in the controller, never via a repo join (ADR-028). */
export const getAccountBalances = (
  deps: Deps,
  filter?: { account?: string; type?: AccountType; projectedAsOf?: string },
): ResultAsync<AccountBalancesResult, AppError> =>
  safeTry(async function* () {
    const candidates = await listAccounts(deps, filter?.type);
    const accounts = filter?.account
      ? [yield* resolutionToResult(resolveByName(candidates, filter.account), 'account')]
      : candidates;

    const balances: AccountBalance[] = [];
    for (const account of accounts) {
      const parts = await deps.accounts.balanceParts(account.id);
      const balance = computeBalance({ initialBalance: account.initialBalance, ...parts });

      const projectedBalance = filter?.projectedAsOf
        ? computeProjectedBalance(
            balance,
            await deps.transactions.pendingBalanceParts(account.id, filter.projectedAsOf),
          )
        : undefined;

      balances.push({ ...account, ...parts, balance, projectedBalance });
    }

    const [settingsRow, currencies, rates] = await Promise.all([
      deps.settings.getLocale(),
      deps.currencies.list(),
      deps.currencyRates.list(),
    ]);
    const baseCurrency = resolveBaseCurrency(settingsRow?.baseCurrency, settingsRow?.locale ?? Locale.enum.en);
    const baseDecimals = decimalsLookup(currencies)(baseCurrency);
    const now = deps.clock();

    const valued = balances.map((b) =>
      valueAccount(b, baseCurrency, rates, now, baseDecimals, deps.rateStaleness),
    );
    const consolidatedNetWorth = consolidateNetWorth(valued, baseCurrency, baseDecimals);

    return ok({ balances: valued, consolidatedNetWorth });
  });

export const deleteAccount = (deps: Deps, name: string): ResultAsync<FlowOutcome<{ deleted: boolean }>, AppError> =>
  safeTry(async function* () {
    const account = yield* resolveAccountRef(deps, name);
    yield* guard(assertNonCreditType(account.type), accountErrors.creditRejected);
    const refs = await deps.accounts.countReferences(account.id);
    yield* guard(isUnreferenced(refs), accountErrors.inUse(account.name, refs));

    const raw = yield* okOr(await deps.accounts.findRawById(account.id), notFound('account', account.id, []));
    const persist = [persistence.remove({ entity: ACCOUNT_ENTITY_TAG, id: raw.id, version: raw.version })];
    return ok({ persist, response: { deleted: true } });
  });

export const updateAccount = (deps: Deps, input: UpdateAccount): ResultAsync<FlowOutcome<Account>, AppError> =>
  safeTry(async function* () {
    const account = yield* resolveAccountRef(deps, input.name);
    yield* guard(assertNonCreditType(account.type), accountErrors.creditRejected);
    yield* guard(assertNonCreditType(input.type), accountErrors.creditRejected);

    if (input.newName && input.newName.toLowerCase() !== account.name.toLowerCase()) {
      yield* guard(await assertNameAvailable(deps, input.newName), accountErrors.duplicateName(input.newName));
    }

    if (R.isDefined(input.type) || R.isDefined(input.currency)) {
      const refs = await deps.accounts.countReferences(account.id);
      if (R.isDefined(input.type)) {
        yield* guard(hasNoTransactions(refs), accountErrors.typeImmutable(refs.transactions));
      }
      if (R.isDefined(input.currency)) {
        yield* guard(hasNoTransactions(refs), accountErrors.currencyImmutableTransactions(refs.transactions));
        yield* guard(hasNoRecurring(refs), accountErrors.currencyImmutableRecurring);
        yield* guard(hasNoCards(refs), accountErrors.currencyImmutableCards);
      }
    }

    const raw = yield* okOr(await deps.accounts.findRawById(account.id), notFound('account', account.id, []));
    const entity: AccountEntity = {
      ...raw,
      name: input.newName ?? raw.name,
      initialBalance: input.initialBalance ?? raw.initialBalance,
      type: input.type ?? raw.type,
      currency: input.currency ?? raw.currency,
    };

    const locale = await deps.locale();
    const persist = R.isDeepEqual(entity, raw)
      ? []
      : [persistence.update({ entity: ACCOUNT_ENTITY_TAG, model: entity })];
    const response = withTypeLabel(R.omit(entity, ['version']), locale);
    return ok({ persist, response });
  });
