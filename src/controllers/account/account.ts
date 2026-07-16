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
import * as persistence from '../../logic/persistence.js';
import { resolveByName } from '../../logic/resolve.js';
import { accountErrors, ACCOUNT_ENTITY_TAG } from '../../models/account.js';
import type {
  Account,
  AccountBalance,
  AccountEntity,
  AccountType,
  CreateAccount,
  UpdateAccount,
} from '../../models/account.js';
import { notFound } from '../../models/error.js';
import type { FlowOutcome, Persistable } from '../../models/persistable.js';
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
 *  shell (the MCP/REST handler's `outcomeToDb` + `withUnitOfWork`) adapts and applies the batch
 *  and returns `response`. A new account has no `version` to decide (that's the shell's own
 *  structural constant, `INITIAL_VERSION` in `models/persistable.ts`) — the model built here, and
 *  the response, are both the plain wire-shaped `Account`. */
export const createAccount = (deps: Deps, input: CreateAccount): ResultAsync<FlowOutcome<Account>, AppError> =>
  safeTry(async function* () {
    yield* guard(assertNonCreditType(input.type), accountErrors.creditRejected);
    yield* guard(await assertNameAvailable(deps, input.name), accountErrors.duplicateName(input.name));

    const account: Account = { id: deps.newId(), ...input };
    const persist: Persistable[] = [persistence.insert({ entity: ACCOUNT_ENTITY_TAG, model: account })];
    return ok({ persist, response: account });
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
    const persist = [persistence.update({ entity: ACCOUNT_ENTITY_TAG, model: entity })];
    const response = withTypeLabel(R.omit(entity, ['version']), locale);
    return ok({ persist, response });
  });
