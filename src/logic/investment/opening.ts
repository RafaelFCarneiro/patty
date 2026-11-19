import type { PersistOutcome } from '@rfc0/effect-runner';
import { err, ok, type Result } from 'neverthrow';
import * as R from 'remeda';
import { AccountType, type Account } from '../../models/account.js';
import { Id } from '../../models/id.js';
import {
  InvestmentEventType,
  investmentErrors,
  investmentWarnings,
  type CostResolution,
  type InvestmentError,
  type InvestmentEvent,
  type OpeningFacts,
  type OpeningPlan,
  type OpenPositionResult,
  type OpeningRule,
} from '../../models/investment/core.js';
import type { Asset } from '../../models/investment/asset.js';
import { roundToDecimals } from '../money.js';
import * as assetRules from './asset.js';
import * as investmentEvents from './events.js';
import * as idempotency from './idempotency.js';

const isNotInvestmentAccount = ({ account }: OpeningFacts): boolean => account.type !== AccountType.enum.investment;

const refuseNotInvestmentAccount = ({ account }: OpeningFacts): InvestmentError =>
  investmentErrors.notInvestmentAccount(account.name, account.type);

const refuseOpeningExists = ({ account, asset }: OpeningFacts): InvestmentError =>
  investmentErrors.openingExists(account.name, assetRules.label(asset));

const givenCost = ({ input }: OpeningFacts): CostResolution | undefined =>
  input.avgCost === undefined ? undefined : { unitCost: input.avgCost, warnings: [] };

const costFromLatestPrice = ({ asset, price }: OpeningFacts): CostResolution | undefined =>
  price && {
    unitCost: price.price,
    warnings: [investmentWarnings.costFromPrice(assetRules.label(asset), price.price, price.asOf)],
  };

const resolveUnitCost = (facts: OpeningFacts): Result<CostResolution, InvestmentError> => {
  const resolution = givenCost(facts) ?? costFromLatestPrice(facts);
  return resolution ? ok(resolution) : err(investmentErrors.noPriceNoCost(assetRules.label(facts.asset)));
};

const cashReplaced = (account: Pick<Account, 'initialBalance'>, remainingCash: number): number | null =>
  account.initialBalance === remainingCash ? null : account.initialBalance;

const openingEvent = (facts: OpeningFacts, unitCost: number, replacedCash: number | null): InvestmentEvent => ({
  id: facts.id,
  accountId: facts.account.id,
  assetId: facts.asset.id,
  type: InvestmentEventType.enum.opening,
  date: facts.input.date ?? facts.today,
  quantity: facts.input.quantity,
  unitCost,
  note: facts.input.note ?? null,
  replacedCash,
});

const isRecordedAgain = (facts: OpeningFacts): boolean => {
  const cost = givenCost(facts) ?? costFromLatestPrice(facts);
  return (
    facts.existingOpening !== undefined &&
    cost !== undefined &&
    idempotency.deriveKey(openingEvent(facts, cost.unitCost, null), facts.decimals) ===
      idempotency.deriveKey(facts.existingOpening, facts.decimals)
  );
};

const conflictsWithExistingOpening = (facts: OpeningFacts): boolean =>
  facts.existingOpening !== undefined && !isRecordedAgain(facts);

const RULES: readonly OpeningRule[] = [
  [isNotInvestmentAccount, refuseNotInvestmentAccount],
  [conflictsWithExistingOpening, refuseOpeningExists],
];

const buildOpeningPlan = (facts: OpeningFacts, { unitCost, warnings }: CostResolution): OpeningPlan => {
  const initialBalance = facts.input.remainingCash ?? 0;
  const event = openingEvent(facts, unitCost, cashReplaced(facts.account, initialBalance));
  return {
    event,
    idempotencyKey: idempotency.deriveKey(event, facts.decimals),
    initialBalance,
    warnings,
    recordedBefore: facts.existingOpening ?? null,
  };
};

export const plan = (facts: OpeningFacts): Result<OpeningPlan, InvestmentError> => {
  const violated = R.find(RULES, ([isViolated]) => isViolated(facts));
  return violated
    ? err(violated[1](facts))
    : resolveUnitCost(facts).map((resolution) => buildOpeningPlan(facts, resolution));
};

export const result = (
  plan: OpeningPlan,
  account: Pick<Account, 'name'>,
  asset: Asset,
  decimals: number,
): OpenPositionResult => ({
  ...investmentEvents.view(plan.recordedBefore ?? plan.event, account, asset),
  costBasis: roundToDecimals(plan.event.quantity * plan.event.unitCost, decimals),
  warnings: plan.warnings,
  created: plan.recordedBefore === null,
});

export const resolveResponse = (planned: OpenPositionResult, outcome: PersistOutcome): OpenPositionResult => ({
  ...planned,
  id: Id.parse(outcome.read),
  created: outcome.applied,
});
