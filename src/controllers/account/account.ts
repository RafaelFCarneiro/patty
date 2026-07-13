import { ok, safeTry, type ResultAsync } from 'neverthrow';
import * as R from 'remeda';
import type { AppError } from '../../common/errors.js';
import { guard } from '../../common/result.js';
import type { AccountPatch } from '../../diplomat/db/repos/accounts.js';
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
import { resolveByName } from '../../logic/resolve.js';
import { accountErrors } from '../../models/account.js';
import type {
  Account,
  AccountBalance,
  AccountEntity,
  AccountType,
  CreateAccount,
  UpdateAccount,
} from '../../models/account.js';
import { EntityTag, type FlowOutcome, type Persistable } from '../../models/persistable.js';
import type { Deps } from '../deps.js';
import { resolveAccountRef, resolutionToResult } from '../resolve.js';

/** Repo-touching precondition: true when no account already holds this name. */
const assertNameAvailable = async (deps: Deps, name: string): Promise<boolean> =>
  !(await deps.accounts.findByName(name));

export const listAccounts = async (deps: Deps, type?: AccountType): Promise<Account[]> => {
  const [locale, all] = await Promise.all([deps.locale(), deps.accounts.list()]);
  return R.pipe(all, R.filter(filterByType(type)), R.map(withTypeLabel(locale)));
};

/** First mover for ADR-021 / docs/functional-core-imperative-shell.md: a functional-core flow —
 *  it decides and returns the write as data (`persist`) instead of performing it. The imperative
 *  shell (`withUnitOfWork`, called from the MCP/REST handlers) applies the batch and returns
 *  `response`. `version: 0` is the entity's initial optimistic-concurrency token; internal only —
 *  stripped from `response`, which stays the plain wire-shaped `Account`. */
export const createAccount = (deps: Deps, input: CreateAccount): ResultAsync<FlowOutcome<Account>, AppError> =>
  safeTry(async function* () {
    yield* guard(assertNonCreditType(input.type), accountErrors.creditRejected);
    yield* guard(await assertNameAvailable(deps, input.name), accountErrors.duplicateName(input.name));

    const account: AccountEntity = { id: deps.newId(), version: 0, ...input };
    const persist: Persistable[] = [{ op: 'insert', entity: EntityTag.enum.account, model: account }];
    return ok({ persist, response: R.omit(account, ['version']) });
  });

/** Balances are derived: initialBalance + income − expenses + transfers in − transfers out. */
export const getAccountBalances = (
  deps: Deps,
  filter?: { account?: string; type?: AccountType; projectedAsOf?: string },
): ResultAsync<AccountBalance[], AppError> =>
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
    return ok(balances);
  });

export const deleteAccount = (deps: Deps, name: string): ResultAsync<{ deleted: boolean }, AppError> =>
  safeTry(async function* () {
    const account = yield* resolveAccountRef(deps, name);
    yield* guard(assertNonCreditType(account.type), accountErrors.creditRejected);
    const refs = await deps.accounts.countReferences(account.id);
    yield* guard(isUnreferenced(refs), accountErrors.inUse(account.name, refs));
    await deps.accounts.delete(account.id);
    return ok({ deleted: true });
  });

export const updateAccount = (deps: Deps, input: UpdateAccount): ResultAsync<Account, AppError> =>
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

    const patch: AccountPatch = {};
    if (R.isDefined(input.newName)) patch.name = input.newName;
    if (R.isDefined(input.initialBalance)) patch.initialBalance = input.initialBalance;
    if (R.isDefined(input.type)) patch.type = input.type;
    if (R.isDefined(input.currency)) patch.currency = input.currency;

    const locale = await deps.locale();
    return ok(withTypeLabel(await deps.accounts.update(account.id, patch), locale));
  });
