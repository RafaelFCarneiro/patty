import { ok, safeTry, type ResultAsync } from 'neverthrow';
import * as R from 'remeda';
import type { AppError } from '../../common/errors.js';
import { guard, okOr } from '../../common/result.js';
import {
  assertNonCreditType,
  changesPinnedField,
  filterByType,
  guardPinnedFields,
  isRename,
  isUnreferenced,
  mergeAccountPatch,
  withTypeLabel,
} from '../../logic/account.js';
import { computeBalance, computeProjectedBalance } from '../../logic/balance.js';
import { consolidateNetWorth, valueAccount } from '../../logic/currencyRate.js';
import { resolveBaseCurrency } from '../../logic/locale.js';
import { decimalsLookup } from '../../logic/money.js';
import * as persistence from '../../logic/persistence.js';
import { resolveByName } from '../../logic/resolve.js';
import {
  accountErrors,
  ACCOUNT_ENTITY_TAG,
  type Account,
  type AccountBalance,
  type AccountBalancesResult,
  type AccountType,
  type CreateAccount,
  type UpdateAccount,
} from '../../models/account.js';
import { notFound } from '../../models/error.js';
import { Locale } from '../../models/locale.js';
import type { FlowOutcome, Persistable } from '@rfc0/effect-runner';
import { Remedy } from '../../models/remedy.js';
import type { Deps } from '../deps.js';
import { resolveAccountRef, resolutionToResult } from '../resolve.js';

const assertNameAvailable = async (deps: Deps, name: string): Promise<boolean> =>
  !(await deps.accounts.findByName(name));

export const listAccounts = async (deps: Deps, type?: AccountType): Promise<Account[]> => {
  const [locale, all] = await Promise.all([deps.locale(), deps.accounts.list()]);
  return R.pipe(all, R.filter(filterByType(type)), R.map(withTypeLabel(locale)));
};

export const createAccount = (deps: Deps, input: CreateAccount): ResultAsync<FlowOutcome<Account>, AppError> =>
  safeTry(async function* () {
    yield* guard(assertNonCreditType(input.type), accountErrors.creditRejected(Remedy.enum.create_credit_card));
    yield* guard(await assertNameAvailable(deps, input.name), accountErrors.duplicateName(input.name));

    const account: Account = { id: deps.newId(), ...input };
    const persist: Persistable[] = [persistence.insert({ entity: ACCOUNT_ENTITY_TAG, model: account })];
    return ok({ persist, response: account });
  });

export const getAccountBalances = (
  deps: Deps,
  filter?: { account?: string; type?: AccountType; projectedAsOf?: string },
): ResultAsync<AccountBalancesResult, AppError> =>
  safeTry(async function* () {
    const candidates = await listAccounts(deps, filter?.type);
    const accounts = filter?.account
      ? [yield* resolutionToResult(resolveByName(candidates, filter.account), 'account')]
      : candidates;

    const balances: AccountBalance[] = await Promise.all(
      accounts.map(async (account) => {
        const parts = await deps.accounts.balanceParts(account.id);
        const balance = computeBalance({ initialBalance: account.initialBalance, ...parts });
        const projectedBalance = filter?.projectedAsOf
          ? computeProjectedBalance(
              balance,
              await deps.transactions.pendingBalanceParts(account.id, filter.projectedAsOf),
            )
          : undefined;
        return { ...account, ...parts, balance, projectedBalance };
      }),
    );

    const [settingsRow, currencies, rates] = await Promise.all([
      deps.settings.getLocale(),
      deps.currencies.list(),
      deps.currencyRates.list(),
    ]);
    const baseCurrency = resolveBaseCurrency(settingsRow?.baseCurrency, settingsRow?.locale ?? Locale.enum.en);
    const baseDecimals = decimalsLookup(currencies)(baseCurrency);
    const now = deps.clock();

    const valued = balances.map((b) => valueAccount(b, baseCurrency, rates, now, baseDecimals, deps.rateStaleness));
    const consolidatedNetWorth = consolidateNetWorth(valued, baseCurrency, baseDecimals);

    return ok({ balances: valued, consolidatedNetWorth });
  });

export const deleteAccount = (deps: Deps, name: string): ResultAsync<FlowOutcome<{ deleted: boolean }>, AppError> =>
  safeTry(async function* () {
    const account = yield* resolveAccountRef(deps, name);
    yield* guard(assertNonCreditType(account.type), accountErrors.creditRejected(Remedy.enum.delete_credit_card));
    const refs = await deps.accounts.countReferences(account.id);
    yield* guard(isUnreferenced(refs), accountErrors.inUse(account.name, refs));

    const raw = yield* okOr(await deps.accounts.findRawById(account.id), notFound('account', account.id, []));
    const persist = [persistence.remove({ entity: ACCOUNT_ENTITY_TAG, id: raw.id, version: raw.version })];
    return ok({ persist, response: { deleted: true } });
  });

const guardRenameAvailable = (deps: Deps, account: Account, newName?: string): ResultAsync<void, AppError> =>
  safeTry(async function* () {
    if (isRename(account.name, newName)) {
      yield* guard(await assertNameAvailable(deps, newName), accountErrors.duplicateName(newName));
    }
    return ok(undefined);
  });

const guardPinnedFieldChange = (deps: Deps, accountId: string, input: UpdateAccount): ResultAsync<void, AppError> =>
  safeTry(async function* () {
    if (changesPinnedField(input)) {
      yield* guardPinnedFields(await deps.accounts.countReferences(accountId), input);
    }
    return ok(undefined);
  });

export const updateAccount = (deps: Deps, input: UpdateAccount): ResultAsync<FlowOutcome<Account>, AppError> =>
  safeTry(async function* () {
    const account = yield* resolveAccountRef(deps, input.name);
    yield* guard(assertNonCreditType(account.type), accountErrors.creditRejected(Remedy.enum.update_credit_card));
    yield* guard(assertNonCreditType(input.type), accountErrors.creditRejected(Remedy.enum.create_credit_card));
    yield* guardRenameAvailable(deps, account, input.newName);
    yield* guardPinnedFieldChange(deps, account.id, input);

    const raw = yield* okOr(await deps.accounts.findRawById(account.id), notFound('account', account.id, []));
    const entity = mergeAccountPatch(raw, input);

    const locale = await deps.locale();
    const persist = R.isDeepEqual(entity, raw)
      ? []
      : [persistence.update({ entity: ACCOUNT_ENTITY_TAG, model: entity })];
    const response = withTypeLabel(R.omit(entity, ['version']), locale);
    return ok({ persist, response });
  });
