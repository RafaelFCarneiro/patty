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
import { consolidateNetWorth, valueAccount } from '../../logic/currency-rate.js';
import * as persistence from '../../logic/persistence.js';
import { resolveByName } from '../../logic/resolve.js';
import {
  accountErrors,
  ACCOUNT_ENTITY_TAG,
  type Account,
  type AccountBalance,
  type AccountBalancesResult,
  AccountType,
  type AccountEntity,
  type CreateAccount,
  type UpdateAccount,
} from '../../models/account.js';
import { notFound } from '../../models/error.js';
import type { PositionValuation, ValuationContext } from '../../models/investment/core.js';
import type { FlowOutcome, Persistable } from '@rfc0/effect-runner';
import { Remedy } from '../../models/remedy.js';
import type { Deps } from '../deps.js';
import { valueHoldings } from '../investment/portfolio.js';
import { resolveAccountRef, resolutionToResult } from '../resolve.js';
import { loadValuationBasis } from '../valuation.js';
import * as conversion from '../../logic/investment/conversion.js';
import * as netWorth from '../../logic/investment/net-worth.js';

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

const balanceOf = async (deps: Deps, account: Account, projectedAsOf?: string): Promise<AccountBalance> => {
  const parts = await deps.accounts.balanceParts(account.id);
  const balance = computeBalance({ initialBalance: account.initialBalance, ...parts });
  const projectedBalance = projectedAsOf
    ? computeProjectedBalance(balance, await deps.transactions.pendingBalanceParts(account.id, projectedAsOf))
    : undefined;
  return { ...account, ...parts, balance, projectedBalance };
};

const MAX_SNAPSHOT_ATTEMPTS = 3;

type AccountSnapshots = Record<string, AccountEntity>;

const isInvestmentAccount = (account: Account): boolean => account.type === AccountType.enum.investment;

const snapshotsOf = async (deps: Deps, accounts: readonly Account[]): Promise<AccountSnapshots> =>
  R.pipe(
    await Promise.all(
      R.map(R.filter(accounts, isInvestmentAccount), (account) => deps.accounts.findRawById(account.id)),
    ),
    R.filter(R.isNonNullish),
    R.indexBy((snapshot) => snapshot.id),
  );

const withSnapshotCash = (accounts: readonly Account[], snapshots: AccountSnapshots): Account[] =>
  R.map(accounts, (account) => ({
    ...account,
    initialBalance: snapshots[account.id]?.initialBalance ?? account.initialBalance,
  }));

type BalancesAndHoldings = { balances: AccountBalance[]; holdings: PositionValuation[] };

const readBalancesAndHoldings = async (
  deps: Deps,
  accounts: readonly Account[],
  context: ValuationContext,
  projectedAsOf: string | undefined,
  attemptsLeft: number,
): Promise<BalancesAndHoldings> => {
  const before = await snapshotsOf(deps, accounts);
  const [balances, holdings] = await Promise.all([
    Promise.all(withSnapshotCash(accounts, before).map((account) => balanceOf(deps, account, projectedAsOf))),
    valueHoldings(deps, accounts, context),
  ]);
  const settled = conversion.sameVersions(before, await snapshotsOf(deps, accounts));
  return settled || attemptsLeft <= 1
    ? { balances, holdings }
    : readBalancesAndHoldings(deps, accounts, context, projectedAsOf, attemptsLeft - 1);
};

export const getAccountBalances = (
  deps: Deps,
  filter?: { account?: string; type?: AccountType; projectedAsOf?: string },
): ResultAsync<AccountBalancesResult, AppError> =>
  safeTry(async function* () {
    const candidates = await listAccounts(deps, filter?.type);
    const accounts = filter?.account
      ? [yield* resolutionToResult(resolveByName(candidates, filter.account), 'account')]
      : candidates;

    const { baseCurrency, baseDecimals, context } = await loadValuationBasis(deps);
    const read = await readBalancesAndHoldings(deps, accounts, context, filter?.projectedAsOf, MAX_SNAPSHOT_ATTEMPTS);
    const valued = read.balances.map((b) =>
      valueAccount(b, baseCurrency, context.rates, context.now, baseDecimals, deps.rateStaleness),
    );

    return ok({
      balances: netWorth.withAccountHoldings(valued, read.holdings, baseCurrency, baseDecimals),
      consolidatedNetWorth: netWorth.withHoldings(
        consolidateNetWorth(valued, baseCurrency, baseDecimals),
        netWorth.holdings(read.holdings, baseCurrency, baseDecimals),
        baseDecimals,
      ),
    });
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

    const raw = yield* okOr(await deps.accounts.findRawById(account.id), notFound('account', account.id, []));
    yield* guardPinnedFieldChange(deps, account.id, input);
    const entity = mergeAccountPatch(raw, input);

    const locale = await deps.locale();
    const persist = R.isDeepEqual(entity, raw)
      ? []
      : [persistence.update({ entity: ACCOUNT_ENTITY_TAG, model: entity })];
    const response = withTypeLabel(R.omit(entity, ['version', 'cashBeforeHoldings']), locale);
    return ok({ persist, response });
  });
