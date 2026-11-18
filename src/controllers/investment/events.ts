import { ok, ResultAsync, safeTry, type Result } from 'neverthrow';
import * as R from 'remeda';
import type { FlowOutcome, Persistable } from '@rfc0/effect-runner';
import type { AppError } from '../../common/errors.js';
import { okOr } from '../../common/result.js';
import { latestPrice } from '../../logic/asset.js';
import {
  eventView,
  isOpening,
  mergeEventPatch,
  openingResult,
  planOpening,
  type OpeningPlan,
} from '../../logic/investment.js';
import * as persistence from '../../logic/persistence.js';
import { toIsoDate } from '../../logic/period.js';
import { ACCOUNT_ENTITY_TAG, type Account } from '../../models/account.js';
import type { Asset } from '../../models/asset.js';
import { notFound } from '../../models/error.js';
import {
  INVESTMENT_EVENT_ENTITY_TAG,
  investmentErrors,
  type DeleteInvestmentEventInput,
  type InvestmentEvent,
  type InvestmentEventView,
  type ListInvestmentEventsInput,
  type OpenPositionInput,
  type OpenPositionResult,
  type UpdateInvestmentEventInput,
} from '../../models/investment.js';
import type { Deps } from '../deps.js';
import { resolveAccountRef, resolveAssetRef, resolveDecimals } from '../resolve.js';

const viewsOf = async (deps: Deps, events: readonly InvestmentEvent[]): Promise<InvestmentEventView[]> => {
  const [accounts, assets] = await Promise.all([deps.accounts.list(), deps.assets.list()]);
  const accountById = R.indexBy(accounts, (account) => account.id);
  const assetById = R.indexBy(assets, (asset) => asset.id);
  return R.pipe(
    events,
    R.map((event) => ({ event, account: accountById[event.accountId], asset: assetById[event.assetId] })),
    R.filter((row) => row.account !== undefined && row.asset !== undefined),
    R.map((row) => eventView(row.event, row.account!, row.asset!)),
  );
};

const gatherOpening = async (deps: Deps, input: OpenPositionInput, account: Account, asset: Asset) => {
  const [existing, prices, decimals] = await Promise.all([
    deps.investments.list({ accountId: account.id, assetId: asset.id }),
    deps.assetPrices.latest(),
    resolveDecimals(deps, asset.currency),
  ]);
  return {
    id: deps.newId(),
    today: toIsoDate(deps.clock()),
    input,
    account,
    asset,
    price: latestPrice(prices, asset.id),
    hasOpening: existing.some(isOpening),
    decimals,
  };
};

/** The account's cash after the conversion is written in the same batch as the event (ADR-038 §7), so the old static
 *  balance and the holding are never both counted. An account already at that cash is not rewritten. */
const cashWrites = async (
  deps: Deps,
  account: Account,
  plan: OpeningPlan,
): Promise<Result<Persistable[], AppError>> => {
  if (account.initialBalance === plan.initialBalance) return ok([]);
  const raw = await deps.accounts.findRawById(account.id);
  return okOr(raw, notFound('account', account.id, [])).map((entity) => [
    persistence.update({ entity: ACCOUNT_ENTITY_TAG, model: { ...entity, initialBalance: plan.initialBalance } }),
  ]);
};

export const openPosition = (
  deps: Deps,
  input: OpenPositionInput,
): ResultAsync<FlowOutcome<OpenPositionResult>, AppError> =>
  safeTry(async function* () {
    const account = yield* resolveAccountRef(deps, input.account);
    const asset = yield* resolveAssetRef(deps, input.asset);
    const facts = await gatherOpening(deps, input, account, asset);
    const plan = yield* planOpening(facts);
    const cash = yield* await cashWrites(deps, account, plan);
    const event = persistence.insert({
      entity: INVESTMENT_EVENT_ENTITY_TAG,
      model: plan.event,
      idempotencyKey: plan.idempotencyKey,
    });
    return ok({ persist: [...cash, event], response: openingResult(plan, account, asset, facts.decimals) });
  });

export const listInvestmentEvents = (
  deps: Deps,
  input: ListInvestmentEventsInput,
): ResultAsync<InvestmentEventView[], AppError> =>
  safeTry(async function* () {
    const account = input.account ? yield* resolveAccountRef(deps, input.account) : undefined;
    const asset = input.asset ? yield* resolveAssetRef(deps, input.asset) : undefined;
    const events = await deps.investments.list({ accountId: account?.id, assetId: asset?.id });
    return ok(await viewsOf(deps, events));
  });

export const updateInvestmentEvent = (
  deps: Deps,
  input: UpdateInvestmentEventInput,
): ResultAsync<FlowOutcome<InvestmentEventView>, AppError> =>
  safeTry(async function* () {
    const existing = yield* okOr(await deps.investments.findById(input.id), investmentErrors.unknownEvent(input.id));
    const entity = mergeEventPatch(existing, input);
    const [view] = await viewsOf(deps, [entity]);
    const response = yield* okOr(view, investmentErrors.unknownEvent(input.id));
    const persist = R.isDeepEqual(entity, existing)
      ? []
      : [persistence.update({ entity: INVESTMENT_EVENT_ENTITY_TAG, model: entity })];
    return ok({ persist, response });
  });

/** Idempotent by design, like `deleteTag`: an id that is not the caller's (or is gone) deletes nothing. */
export const deleteInvestmentEvent = (
  deps: Deps,
  input: DeleteInvestmentEventInput,
): ResultAsync<FlowOutcome<{ deleted: boolean }>, AppError> =>
  ResultAsync.fromSafePromise(deps.investments.findById(input.id)).map((existing) => ({
    persist: existing
      ? [persistence.remove({ entity: INVESTMENT_EVENT_ENTITY_TAG, id: existing.id, version: existing.version })]
      : [],
    response: { deleted: existing !== null },
  }));
