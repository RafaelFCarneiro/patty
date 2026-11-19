import { ok, type ResultAsync, safeTry, type Result } from 'neverthrow';
import * as R from 'remeda';
import type { FlowOutcome, Persistable, PersistOutcome } from '@rfc0/effect-runner';
import type { AppError } from '../../common/errors.js';
import { okOr, orRefuse } from '../../common/result.js';
import * as persistence from '../../logic/persistence.js';
import { toIsoDate } from '../../logic/period.js';
import { ACCOUNT_ENTITY_TAG, type Account, type AccountEntity } from '../../models/account.js';
import type { Asset } from '../../models/investment/asset.js';
import { notFound } from '../../models/error.js';
import {
  INVESTMENT_EVENT_ENTITY_TAG,
  investmentErrors,
  type DeleteInvestmentEventInput,
  type DeleteInvestmentEventResult,
  type InvestmentEvent,
  type EventRow,
  type InvestmentEventEntity,
  type InvestmentEventView,
  type ListInvestmentEventsInput,
  type OpenPositionInput,
  type OpenPositionResult,
  type OpeningPlan,
  type UpdateInvestmentEventInput,
} from '../../models/investment/core.js';
import type { Deps } from '../deps.js';
import { resolveAccountRef, resolveAssetRef, resolveDecimals } from '../resolve.js';
import * as assetRules from '../../logic/investment/asset.js';
import * as investmentEvents from '../../logic/investment/events.js';
import * as opening from '../../logic/investment/opening.js';

const isDisplayable = (row: EventRow): row is { event: InvestmentEvent; account: Account; asset: Asset } =>
  row.account !== undefined && row.asset !== undefined;

const viewsOf = async (deps: Deps, events: readonly InvestmentEvent[]): Promise<InvestmentEventView[]> => {
  const [accounts, assets] = await Promise.all([deps.accounts.list(), deps.assets.list()]);
  const accountById = R.indexBy(accounts, (account) => account.id);
  const assetById = R.indexBy(assets, (asset) => asset.id);
  return R.pipe(
    events,
    R.map((event) => ({ event, account: accountById[event.accountId], asset: assetById[event.assetId] })),
    R.filter(isDisplayable),
    R.map((row) => investmentEvents.view(row.event, row.account, row.asset)),
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
    price: assetRules.latestPrice(prices, asset.id),
    existingOpening: R.find(existing, investmentEvents.isOpening),
    decimals,
  };
};

const remainingCashWrite = (snapshot: AccountEntity, plan: OpeningPlan): Persistable =>
  snapshot.initialBalance === plan.initialBalance
    ? persistence.check({ entity: ACCOUNT_ENTITY_TAG, id: snapshot.id, version: snapshot.version })
    : persistence.update({
        entity: ACCOUNT_ENTITY_TAG,
        model: { ...snapshot, initialBalance: plan.initialBalance },
      });

export const openPosition = (
  deps: Deps,
  input: OpenPositionInput,
): ResultAsync<FlowOutcome<OpenPositionResult>, AppError> =>
  safeTry(async function* () {
    const resolved = yield* resolveAccountRef(deps, input.account);
    const asset = yield* resolveAssetRef(deps, input.asset);
    const snapshot = yield* okOr(await deps.accounts.findRawById(resolved.id), notFound('account', resolved.id, []));
    const facts = await gatherOpening(deps, input, snapshot, asset);
    const plan = yield* opening.plan(facts);
    const event = persistence.insert({
      entity: INVESTMENT_EVENT_ENTITY_TAG,
      model: plan.event,
      idempotencyKey: plan.idempotencyKey,
    });
    const planned = opening.result(plan, snapshot, asset, facts.decimals);
    return ok(
      plan.recordedBefore
        ? { persist: [], response: planned }
        : {
            persist: [remainingCashWrite(snapshot, plan), event],
            response: (outcomes: PersistOutcome[]) =>
              opening.resolveResponse(planned, persistence.outcomeFor(INVESTMENT_EVENT_ENTITY_TAG, outcomes)),
          },
    );
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
    const entity = investmentEvents.mergePatch(existing, input);
    const [view] = await viewsOf(deps, [entity]);
    const response = yield* okOr(view, investmentErrors.unknownEvent(input.id));
    const persist = R.isDeepEqual(entity, existing)
      ? []
      : [persistence.update({ entity: INVESTMENT_EVENT_ENTITY_TAG, model: entity })];
    return ok({ persist, response });
  });

const restoreReplacedCash = async (
  deps: Deps,
  event: InvestmentEventEntity,
): Promise<Result<{ writes: Persistable[]; restored?: DeleteInvestmentEventResult['restoredCash'] }, AppError>> => {
  const cash = investmentEvents.cashToRestore(event);
  if (cash === null) return ok({ writes: [] });
  const [raw, onAccount] = await Promise.all([
    deps.accounts.findRawById(event.accountId),
    deps.investments.list({ accountId: event.accountId }),
  ]);
  return okOr(raw, notFound('account', event.accountId, [])).andThen((account) =>
    orRefuse(
      investmentEvents.refusalToDelete(
        event,
        R.filter(onAccount, (sibling) => sibling.id !== event.id),
        account,
      ),
    ).map(() => ({
      writes: [persistence.update({ entity: ACCOUNT_ENTITY_TAG, model: { ...account, initialBalance: cash } })],
      restored: { account: account.name, initialBalance: cash },
    })),
  );
};

export const deleteInvestmentEvent = (
  deps: Deps,
  input: DeleteInvestmentEventInput,
): ResultAsync<FlowOutcome<DeleteInvestmentEventResult>, AppError> =>
  safeTry(async function* () {
    const existing = await deps.investments.findById(input.id);
    if (existing === null) return ok({ persist: [], response: { deleted: false } });
    const { writes, restored } = yield* await restoreReplacedCash(deps, existing);
    const removal = persistence.remove({
      entity: INVESTMENT_EVENT_ENTITY_TAG,
      id: existing.id,
      version: existing.version,
    });
    return ok({ persist: [...writes, removal], response: { deleted: true, restoredCash: restored } });
  });
