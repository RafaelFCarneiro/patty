import { createHash } from 'node:crypto';
import { err, ok, type Result } from 'neverthrow';
import * as R from 'remeda';
import { AccountType, type Account } from '../models/account.js';
import type { Asset, AssetPrice, PriceStalenessThresholds } from '../models/asset.js';
import type { ConversionResult, CurrencyRate, StalenessThresholds } from '../models/currency-rate.js';
import {
  InvestmentEventType,
  PositionExclusionReason,
  investmentErrors,
  investmentWarnings,
  type AccountHoldings,
  type AllocationSlice,
  type BaseValuation,
  type ExcludedPosition,
  type InvestmentError,
  type InvestmentEvent,
  type InvestmentEventEntity,
  type InvestmentEventView,
  type NetWorthHoldings,
  type OpenPositionInput,
  type OpenPositionResult,
  type PortfolioTotals,
  type PortfolioView,
  type Position,
  type PositionValuation,
  type UpdateInvestmentEventInput,
} from '../models/investment.js';
import type { CurrencyCode, DecimalsFor } from '../models/money.js';
import { assetLabel, isPriceStale, latestPrice } from './asset.js';
import { convert } from './currency-rate.js';
import { roundToDecimals } from './money.js';

const PERCENT = 100;
const PERCENT_DECIMALS = 2;

// ── Positions: a pure fold of the events (ADR-038 §2) ────────────────────────────────────────────────────────────

type PositionState = Pick<Position, 'quantity' | 'avgCost'>;

const NO_POSITION: PositionState = { quantity: 0, avgCost: 0 };

const keepPosition = (state: PositionState): PositionState => state;

/** What each event does to a position. An opening sets both quantity and average cost; buy, sell and split are the
 *  schema's room for ADR-038 step 2 and are not accepted by any flow yet, so they leave the position as it is. */
const EVENT_STEPS = {
  [InvestmentEventType.enum.opening]: (_state, event) => ({ quantity: event.quantity, avgCost: event.unitCost }),
  [InvestmentEventType.enum.buy]: keepPosition,
  [InvestmentEventType.enum.sell]: keepPosition,
  [InvestmentEventType.enum.split]: keepPosition,
} as const satisfies Record<InvestmentEventType, (state: PositionState, event: InvestmentEvent) => PositionState>;

const applyEvent = (state: PositionState, event: InvestmentEvent): PositionState =>
  EVENT_STEPS[event.type](state, event);

/** The quantity and average cost one position's events add up to, applied in date order. */
export const foldPosition = (events: readonly InvestmentEvent[]): PositionState =>
  R.pipe(
    events,
    R.sortBy((event) => event.date),
    R.reduce(applyEvent, NO_POSITION),
  );

const positionKey = (event: InvestmentEvent): string => JSON.stringify([event.accountId, event.assetId]);

const toPosition = (events: readonly [InvestmentEvent, ...InvestmentEvent[]]): Position => ({
  accountId: events[0].accountId,
  assetId: events[0].assetId,
  ...foldPosition(events),
});

export const isOpening = (event: Pick<InvestmentEvent, 'type'>): boolean =>
  event.type === InvestmentEventType.enum.opening;

const isHeld = (position: Position): boolean => position.quantity > 0;

/** Every position the events add up to (an account × asset each); a position that nets to nothing is not listed. */
export const foldPositions = (events: readonly InvestmentEvent[]): Position[] =>
  R.pipe(events, R.groupBy(positionKey), R.values(), R.filter(R.isDefined), R.map(toPosition), R.filter(isHeld));

// ── Idempotency (ADR-029) ────────────────────────────────────────────────────────────────────────────────────────

export type InvestmentEventIdentity = Pick<
  InvestmentEvent,
  'accountId' | 'assetId' | 'type' | 'date' | 'quantity' | 'unitCost'
>;

/** The key is domain-derived: the event's full deterministic identity, the unit cost rounded to the asset currency's
 *  own decimals, plus an optional discriminator for a genuinely distinct event that would derive an identical key. The
 *  JSON array keeps every field boundary unambiguous whatever the discriminator holds. */
export const deriveInvestmentEventKey = (
  identity: InvestmentEventIdentity,
  decimals: number,
  discriminator?: string,
): string =>
  createHash('sha256')
    .update(
      JSON.stringify([
        identity.accountId,
        identity.assetId,
        identity.type,
        identity.date,
        identity.quantity,
        roundToDecimals(identity.unitCost, decimals),
        discriminator ?? null,
      ]),
    )
    .digest('hex');

// ── Opening a position (ADR-038 §7) ──────────────────────────────────────────────────────────────────────────────

export type OpeningFacts = {
  id: string;
  today: string;
  input: OpenPositionInput;
  account: Pick<Account, 'id' | 'name' | 'type' | 'initialBalance'>;
  asset: Asset;
  price: AssetPrice | undefined;
  hasOpening: boolean;
  decimals: number;
};

export type OpeningPlan = {
  event: InvestmentEvent;
  idempotencyKey: string;
  /** The account's cash after the conversion — written in the same batch as the event. */
  initialBalance: number;
  warnings: string[];
};

type CostResolution = { unitCost: number; warnings: string[] };

const resolveUnitCost = ({ input, asset, price }: OpeningFacts): Result<CostResolution, InvestmentError> => {
  if (input.avgCost !== undefined) return ok({ unitCost: input.avgCost, warnings: [] });
  return price
    ? ok({
        unitCost: price.price,
        warnings: [investmentWarnings.costFromPrice(assetLabel(asset), price.price, price.asOf)],
      })
    : err(investmentErrors.noPriceNoCost(assetLabel(asset)));
};

const guardOpening = (facts: OpeningFacts): Result<void, InvestmentError> => {
  if (facts.account.type !== AccountType.enum.investment) {
    return err(investmentErrors.notInvestmentAccount(facts.account.name, facts.account.type));
  }
  return facts.hasOpening
    ? err(investmentErrors.openingExists(facts.account.name, assetLabel(facts.asset)))
    : ok(undefined);
};

/** The account cash an opening replaces and must give back when deleted: the balance it had, or nothing when the
 *  opening leaves the account at the cash it already held. */
const replacedCashOf = (account: Pick<Account, 'initialBalance'>, initialBalance: number): number | null =>
  account.initialBalance === initialBalance ? null : account.initialBalance;

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

/** Decides an opening: the account must be an investment account without an opening for the asset yet, and the average
 *  cost is the one given, else the latest price (with a warning), else the call is refused. */
export const planOpening = (facts: OpeningFacts): Result<OpeningPlan, InvestmentError> =>
  guardOpening(facts)
    .andThen(() => resolveUnitCost(facts))
    .map(({ unitCost, warnings }) => {
      const initialBalance = facts.input.remainingCash ?? 0;
      const event = openingEvent(facts, unitCost, replacedCashOf(facts.account, initialBalance));
      return { event, idempotencyKey: deriveInvestmentEventKey(event, facts.decimals), initialBalance, warnings };
    });

// ── Events: views and patches ────────────────────────────────────────────────────────────────────────────────────

export const eventView = (
  event: InvestmentEvent,
  account: Pick<Account, 'name'>,
  asset: Pick<Asset, 'symbol' | 'exchange'>,
): InvestmentEventView => ({
  id: event.id,
  account: account.name,
  asset: assetLabel(asset),
  type: event.type,
  date: event.date,
  quantity: event.quantity,
  avgCost: event.unitCost,
  note: event.note,
  replacedCash: event.replacedCash,
});

/** The account cash that deleting this event gives back: only an opening that replaced some (ADR-038 §7). */
export const cashToRestore = (event: Pick<InvestmentEvent, 'type' | 'replacedCash'>): number | null =>
  isOpening(event) ? event.replacedCash : null;

export const openingResult = (
  plan: OpeningPlan,
  account: Pick<Account, 'name'>,
  asset: Asset,
  decimals: number,
): OpenPositionResult => ({
  ...eventView(plan.event, account, asset),
  costBasis: roundToDecimals(plan.event.quantity * plan.event.unitCost, decimals),
  warnings: plan.warnings,
});

/** The patch laid over the stored event; an omitted field keeps its value, a `null` note clears it. */
export const mergeEventPatch = (
  existing: InvestmentEventEntity,
  patch: UpdateInvestmentEventInput,
): InvestmentEventEntity => ({
  ...existing,
  quantity: patch.quantity ?? existing.quantity,
  unitCost: patch.avgCost ?? existing.unitCost,
  date: patch.date ?? existing.date,
  note: patch.note === undefined ? existing.note : patch.note,
});

// ── Valuation at read time (ADR-038 §4) ──────────────────────────────────────────────────────────────────────────

export type ValuationContext = {
  rates: readonly CurrencyRate[];
  baseCurrency: CurrencyCode;
  decimalsOf: DecimalsFor;
  now: Date;
  rateThresholds: StalenessThresholds;
  priceThresholds: PriceStalenessThresholds;
};

export type PositionFacts = {
  position: Position;
  account: Pick<Account, 'id' | 'name'>;
  asset: Asset;
  price: AssetPrice | undefined;
};

type AssetFigures = Pick<PositionValuation, 'costBasis' | 'marketValue' | 'unrealized'>;

/** Quantity × price in the asset currency. With no price the market value is null — never zero. */
const assetFigures = ({ position, asset, price }: PositionFacts, decimalsOf: DecimalsFor): AssetFigures => {
  const decimals = decimalsOf(asset.currency);
  const costBasis = roundToDecimals(position.quantity * position.avgCost, decimals);
  const marketValue = price ? roundToDecimals(position.quantity * price.price, decimals) : null;
  const unrealized = marketValue === null ? null : roundToDecimals(marketValue - costBasis, decimals);
  return { costBasis, marketValue, unrealized };
};

const toBase = (amount: number, from: CurrencyCode, context: ValuationContext): ConversionResult =>
  convert(amount, from, context.baseCurrency, context.rates, context.now, {
    decimals: context.decimalsOf(context.baseCurrency),
    thresholds: context.rateThresholds,
  });

type BaseFigures = { base: BaseValuation; rateStale: boolean };

const baseFigures = (figures: AssetFigures, from: CurrencyCode, context: ValuationContext): BaseFigures | null => {
  const cost = toBase(figures.costBasis, from, context);
  if (cost.noRate || cost.value === null || cost.rate === null || cost.asOf === null) return null;
  const marketValue = figures.marketValue === null ? null : toBase(figures.marketValue, from, context).value;
  const decimals = context.decimalsOf(context.baseCurrency);
  return {
    rateStale: cost.stale,
    base: {
      currency: context.baseCurrency,
      rate: cost.rate,
      rateAsOf: cost.asOf,
      costBasis: cost.value,
      marketValue,
      unrealized: marketValue === null ? null : roundToDecimals(marketValue - cost.value, decimals),
    },
  };
};

const olderOf = (instants: readonly (string | null)[]): string | null =>
  R.pipe(
    instants,
    R.filter(R.isNonNullish),
    R.firstBy((instant) => new Date(instant).getTime()),
  ) ?? null;

type PriceReading = Pick<PositionValuation, 'price' | 'priceAsOf' | 'noPrice' | 'stale'>;

const NO_PRICE: PriceReading = { price: null, priceAsOf: null, noPrice: true, stale: false };

const readPrice = ({ asset, price }: PositionFacts, context: ValuationContext): PriceReading =>
  price
    ? {
        price: price.price,
        priceAsOf: price.asOf,
        noPrice: false,
        stale: isPriceStale(asset.pricing, price.asOf, context.now, context.priceThresholds),
      }
    : NO_PRICE;

type RateReading = Pick<PositionValuation, 'base' | 'noRate'> & { stale: boolean };

const NO_RATE: RateReading = { base: null, noRate: true, stale: false };

const readRate = (converted: BaseFigures | null): RateReading =>
  converted ? { base: converted.base, noRate: false, stale: converted.rateStale } : NO_RATE;

const identityOf = ({ position, account, asset }: PositionFacts) => ({
  accountId: account.id,
  account: account.name,
  assetId: asset.id,
  asset: assetLabel(asset),
  name: asset.name,
  assetClass: asset.assetClass,
  pricing: asset.pricing,
  currency: asset.currency,
  quantity: position.quantity,
  avgCost: position.avgCost,
});

/** A position at today's price and rate. A missing price or a missing rate leaves the value null and says which; a
 *  stale price or rate still values it, flagged. */
export const valuePosition = (facts: PositionFacts, context: ValuationContext): PositionValuation => {
  const figures = assetFigures(facts, context.decimalsOf);
  const priceReading = readPrice(facts, context);
  const rateReading = readRate(baseFigures(figures, facts.asset.currency, context));
  return {
    ...identityOf(facts),
    ...figures,
    price: priceReading.price,
    priceAsOf: priceReading.priceAsOf,
    noPrice: priceReading.noPrice,
    base: rateReading.base,
    noRate: rateReading.noRate,
    asOf: olderOf([priceReading.priceAsOf, rateReading.base?.rateAsOf ?? null]),
    stale: priceReading.stale || rateReading.stale,
  };
};

/** Values every position of the events: each against its account, its asset and the asset's newest price. */
export const valuePositions = (
  positions: readonly Position[],
  accounts: readonly Pick<Account, 'id' | 'name'>[],
  assets: readonly Asset[],
  prices: readonly AssetPrice[],
  context: ValuationContext,
): PositionValuation[] => {
  const accountById = R.indexBy(accounts, (account) => account.id);
  const assetById = R.indexBy(assets, (asset) => asset.id);
  return R.pipe(
    positions,
    R.map((position) => ({
      position,
      account: accountById[position.accountId],
      asset: assetById[position.assetId],
      price: latestPrice(prices, position.assetId),
    })),
    R.filter((facts): facts is PositionFacts => facts.account !== undefined && facts.asset !== undefined),
    R.map((facts) => valuePosition(facts, context)),
  );
};

// ── Totals and allocation ────────────────────────────────────────────────────────────────────────────────────────

type ValuedPosition = PositionValuation & { base: BaseValuation & { marketValue: number } };

const isValued = (valuation: PositionValuation): valuation is ValuedPosition =>
  valuation.base !== null && valuation.base.marketValue !== null;

/** A position with no price is left out of the totals for that reason; otherwise it is the missing rate. */
const exclusionOf = (valuation: PositionValuation): ExcludedPosition => ({
  account: valuation.account,
  asset: valuation.asset,
  reason: valuation.noPrice ? PositionExclusionReason.enum.no_price : PositionExclusionReason.enum.no_rate,
});

const sumRounded = (
  valued: readonly ValuedPosition[],
  figure: (valuation: ValuedPosition) => number,
  decimals: number,
) => roundToDecimals(R.sumBy(valued, figure), decimals);

const totalsOf = (valued: readonly ValuedPosition[], left: readonly PositionValuation[], base: BaseCurrencyFacts) => {
  const marketValue = sumRounded(valued, (v) => v.base.marketValue, base.decimals);
  const costBasis = sumRounded(valued, (v) => v.base.costBasis, base.decimals);
  return {
    baseCurrency: base.currency,
    marketValue,
    costBasis,
    unrealized: roundToDecimals(marketValue - costBasis, base.decimals),
    stale: valued.some((v) => v.stale),
    asOf: olderOf(valued.map((v) => v.asOf)),
    excluded: R.map(left, exclusionOf),
  } satisfies PortfolioTotals;
};

type BaseCurrencyFacts = { currency: CurrencyCode; decimals: number };

const sliceOf =
  (total: number, decimals: number) =>
  ([key, group]: readonly [string, readonly ValuedPosition[]]): AllocationSlice => {
    const value = R.sumBy(group, (v) => v.base.marketValue);
    return {
      key,
      value: roundToDecimals(value, decimals),
      pct: total === 0 ? 0 : roundToDecimals((value / total) * PERCENT, PERCENT_DECIMALS),
    };
  };

const allocateBy = (
  valued: readonly ValuedPosition[],
  keyOf: (valuation: ValuedPosition) => string,
  decimals: number,
): AllocationSlice[] => {
  const total = R.sumBy(valued, (v) => v.base.marketValue);
  return R.pipe(
    valued,
    R.groupBy(keyOf),
    R.entries(),
    R.map(sliceOf(total, decimals)),
    R.sortBy([(slice) => slice.value, 'desc']),
  );
};

/** The valued positions' totals in the base currency, the share of each asset class and each currency, and the
 *  positions left out (no price or no rate) — named, never counted as zero. */
export const consolidatePortfolio = (
  valuations: readonly PositionValuation[],
  baseCurrency: CurrencyCode,
  baseDecimals: number,
): Pick<PortfolioView, 'totals' | 'allocation'> => {
  const [valued, left] = R.partition(valuations, isValued);
  return {
    totals: totalsOf(valued, left, { currency: baseCurrency, decimals: baseDecimals }),
    allocation: {
      byAssetClass: allocateBy(valued, (v) => v.assetClass, baseDecimals),
      byCurrency: allocateBy(valued, (v) => v.currency, baseDecimals),
    },
  };
};

// ── Net worth (ADR-038 §6) ───────────────────────────────────────────────────────────────────────────────────────

/** Each account's holdings, valued against the same context. */
export const holdingsTotalsByAccount = (
  valuations: readonly PositionValuation[],
  baseCurrency: CurrencyCode,
  baseDecimals: number,
): Record<string, PortfolioTotals> =>
  R.pipe(
    valuations,
    R.groupBy((valuation) => valuation.accountId),
    R.mapValues((group) => consolidatePortfolio(group, baseCurrency, baseDecimals).totals),
  );

/** An investment account's cash and holdings side by side; the total needs the cash converted to the base currency. */
export const accountHoldings = (
  cashBalance: number,
  convertedCash: number | undefined,
  totals: PortfolioTotals,
  baseDecimals: number,
): AccountHoldings => ({
  cashBalance,
  holdingsValue: totals.marketValue,
  baseCurrency: totals.baseCurrency,
  total: convertedCash === undefined ? null : roundToDecimals(convertedCash + totals.marketValue, baseDecimals),
  stale: totals.stale,
  asOf: totals.asOf,
  excluded: totals.excluded,
});

/** What the holdings of the listed accounts add to the consolidated net worth; absent when none holds a position. */
export const netWorthHoldings = (
  valuations: readonly PositionValuation[],
  baseCurrency: CurrencyCode,
  baseDecimals: number,
): NetWorthHoldings | undefined => {
  if (valuations.length === 0) return undefined;
  const { totals } = consolidatePortfolio(valuations, baseCurrency, baseDecimals);
  return { value: totals.marketValue, stale: totals.stale, asOf: totals.asOf, excluded: totals.excluded };
};

type HoldingsHost = { id: string; balance: number; converted?: { value: number } };

/** Every account that holds positions gains its `holdings` block; the others are returned exactly as they were. */
export const withAccountHoldings = <A extends HoldingsHost>(
  balances: readonly A[],
  valuations: readonly PositionValuation[],
  baseCurrency: CurrencyCode,
  baseDecimals: number,
): (A & { holdings?: AccountHoldings })[] => {
  const totalsByAccount = holdingsTotalsByAccount(valuations, baseCurrency, baseDecimals);
  return R.map(balances, (balance) => {
    const totals = totalsByAccount[balance.id];
    return totals
      ? { ...balance, holdings: accountHoldings(balance.balance, balance.converted?.value, totals, baseDecimals) }
      : balance;
  });
};

/** The net worth with the holdings' market value added to its total and itemized; unchanged when nothing is held. */
export const withNetWorthHoldings = <N extends { total: number }>(
  netWorth: N,
  holdings: NetWorthHoldings | undefined,
  baseDecimals: number,
): N & { holdings?: NetWorthHoldings } =>
  holdings
    ? { ...netWorth, total: roundToDecimals(netWorth.total + holdings.value, baseDecimals), holdings }
    : netWorth;
