import { err, ok, type Result } from 'neverthrow';
import * as R from 'remeda';
import { AccountType, type Account } from '../../models/account.js';
import {
  InvestmentEventType,
  investmentErrors,
  investmentWarnings,
  type CostResolution,
  type InvestmentError,
  type InvestmentEvent,
  type OpeningFacts,
  type OpeningPlan,
  type OpeningRule,
} from '../../models/investment/core.js';
import { assetLabel } from './asset.js';
import { deriveInvestmentEventKey } from './idempotency.js';

const isNotInvestmentAccount = ({ account }: OpeningFacts): boolean => account.type !== AccountType.enum.investment;

const refuseNotInvestmentAccount = ({ account }: OpeningFacts): InvestmentError =>
  investmentErrors.notInvestmentAccount(account.name, account.type);

const alreadyHasOpening = ({ hasOpening }: OpeningFacts): boolean => hasOpening;

const refuseOpeningExists = ({ account, asset }: OpeningFacts): InvestmentError =>
  investmentErrors.openingExists(account.name, assetLabel(asset));

const OPENING_RULES: readonly OpeningRule[] = [
  [isNotInvestmentAccount, refuseNotInvestmentAccount],
  [alreadyHasOpening, refuseOpeningExists],
];

const givenCost = ({ input }: OpeningFacts): CostResolution | undefined =>
  input.avgCost === undefined ? undefined : { unitCost: input.avgCost, warnings: [] };

const costFromLatestPrice = ({ asset, price }: OpeningFacts): CostResolution | undefined =>
  price && {
    unitCost: price.price,
    warnings: [investmentWarnings.costFromPrice(assetLabel(asset), price.price, price.asOf)],
  };

const resolveUnitCost = (facts: OpeningFacts): Result<CostResolution, InvestmentError> => {
  const resolution = givenCost(facts) ?? costFromLatestPrice(facts);
  return resolution ? ok(resolution) : err(investmentErrors.noPriceNoCost(assetLabel(facts.asset)));
};

const cashReplacedByOpening = (account: Pick<Account, 'initialBalance'>, remainingCash: number): number | null =>
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

const buildOpeningPlan = (facts: OpeningFacts, { unitCost, warnings }: CostResolution): OpeningPlan => {
  const initialBalance = facts.input.remainingCash ?? 0;
  const event = openingEvent(facts, unitCost, cashReplacedByOpening(facts.account, initialBalance));
  return { event, idempotencyKey: deriveInvestmentEventKey(event, facts.decimals), initialBalance, warnings };
};

export const planOpening = (facts: OpeningFacts): Result<OpeningPlan, InvestmentError> => {
  const violated = R.find(OPENING_RULES, ([isViolated]) => isViolated(facts));
  return violated
    ? err(violated[1](facts))
    : resolveUnitCost(facts).map((resolution) => buildOpeningPlan(facts, resolution));
};
