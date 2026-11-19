import * as R from 'remeda';
import type { Account } from '../../models/account.js';
import type { Asset, AssetPrice } from '../../models/investment/asset.js';
import {
  PositionExclusionReason,
  type AllocationSlice,
  type AssetFigures,
  type BaseCurrencyFacts,
  type BaseFigures,
  type ExcludedPosition,
  type PortfolioTotals,
  type PortfolioView,
  type Position,
  type PositionFacts,
  type PositionValuation,
  type PriceReading,
  type RateReading,
  type ValuationContext,
  type ValuedPosition,
} from '../../models/investment/core.js';
import type { ConversionResult } from '../../models/currency-rate.js';
import type { CurrencyCode, DecimalsFor } from '../../models/money.js';
import { convert } from '../currency-rate.js';
import { roundToDecimals } from '../money.js';
import * as assetRules from './asset.js';

const PERCENT = 100;
const PERCENT_DECIMALS = 2;

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

export const olderOf = (instants: readonly (string | null)[]): string | null =>
  R.pipe(
    instants,
    R.filter(R.isNonNullish),
    R.firstBy((instant) => new Date(instant).getTime()),
  ) ?? null;

const NO_PRICE: PriceReading = { price: null, priceAsOf: null, noPrice: true, stale: false };

const readPrice = ({ asset, price }: PositionFacts, context: ValuationContext): PriceReading =>
  price
    ? {
        price: price.price,
        priceAsOf: price.asOf,
        noPrice: false,
        stale: assetRules.isPriceStale(asset.pricing, price.asOf, context.now, context.priceThresholds),
      }
    : NO_PRICE;

const NO_RATE: RateReading = { base: null, noRate: true, stale: false };

const readRate = (converted: BaseFigures | null): RateReading =>
  converted ? { base: converted.base, noRate: false, stale: converted.rateStale } : NO_RATE;

const identityOf = ({ position, account, asset }: PositionFacts) => ({
  accountId: account.id,
  account: account.name,
  assetId: asset.id,
  asset: assetRules.label(asset),
  name: asset.name,
  assetClass: asset.assetClass,
  pricing: asset.pricing,
  currency: asset.currency,
  quantity: position.quantity,
  avgCost: position.avgCost,
});

export const value = (facts: PositionFacts, context: ValuationContext): PositionValuation => {
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

export const valueAll = (
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
      price: assetRules.latestPrice(prices, position.assetId),
    })),
    R.filter((facts): facts is PositionFacts => facts.account !== undefined && facts.asset !== undefined),
    R.map((facts) => value(facts, context)),
  );
};

const isValued = (valuation: PositionValuation): valuation is ValuedPosition =>
  valuation.base !== null && valuation.base.marketValue !== null;

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

export const consolidate = (
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

export const markStale = (
  valuations: readonly PositionValuation[],
  accountIds: readonly string[],
): PositionValuation[] =>
  R.map(valuations, (valuation) =>
    accountIds.includes(valuation.accountId) ? { ...valuation, stale: true } : valuation,
  );
