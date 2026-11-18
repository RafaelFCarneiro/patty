import * as R from 'remeda';
import type {
  AccountHoldings,
  HoldingsHost,
  NetWorthHoldings,
  PortfolioTotals,
  PositionValuation,
} from '../../models/investment/core.js';
import type { CurrencyCode } from '../../models/money.js';
import { roundToDecimals } from '../money.js';
import { consolidatePortfolio } from './valuation.js';

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

export const netWorthHoldings = (
  valuations: readonly PositionValuation[],
  baseCurrency: CurrencyCode,
  baseDecimals: number,
): NetWorthHoldings | undefined => {
  if (valuations.length === 0) return undefined;
  const { totals } = consolidatePortfolio(valuations, baseCurrency, baseDecimals);
  return { value: totals.marketValue, stale: totals.stale, asOf: totals.asOf, excluded: totals.excluded };
};

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

export const withNetWorthHoldings = <N extends { total: number }>(
  netWorth: N,
  holdings: NetWorthHoldings | undefined,
  baseDecimals: number,
): N & { holdings?: NetWorthHoldings } =>
  holdings
    ? { ...netWorth, total: roundToDecimals(netWorth.total + holdings.value, baseDecimals), holdings }
    : netWorth;
