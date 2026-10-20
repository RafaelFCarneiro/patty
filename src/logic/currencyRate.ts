import type { Result } from 'neverthrow';
import * as R from 'remeda';
import type { CurrencyCode } from '../models/money.js';
import {
  ExclusionReason,
  type ConvertedValue,
  type CurrencyRate,
  type CurrencyRateView,
  type SetExchangeRateInput,
  type CurrencyRateBulkItem,
  CRYPTO_CURRENCIES,
  type StalenessThresholds,
  MS_PER_HOUR,
  type ConversionResult,
  type ConvertOptions,
  type ValuableBalance,
  type ConsolidatedNetWorth,
  type CurrencyAmount,
  type ConsolidatedInCurrency,
} from '../models/currencyRate.js';
import { roundToDecimals } from './money.js';

export const toBulkItem = <E>(
  input: SetExchangeRateInput,
  result: Result<CurrencyRateView, E>,
): CurrencyRateBulkItem<E> =>
  result.match(
    (rate) => ({ status: 'ok', rate }),
    (error) => ({ status: 'error', from: input.from, to: input.to, error }),
  );

export const buildBulkResult = <E>(
  items: readonly SetExchangeRateInput[],
  outcomes: readonly Result<CurrencyRateView, E>[],
): CurrencyRateBulkItem<E>[] =>
  R.pipe(
    R.zip(items, outcomes),
    R.map(([input, outcome]) => toBulkItem(input, outcome)),
  );

export const isCryptoPair = (from: CurrencyCode, to: CurrencyCode): boolean =>
  CRYPTO_CURRENCIES.has(from) || CRYPTO_CURRENCIES.has(to);

export const isStale = (asOf: string, now: Date, thresholdHours: number): boolean =>
  now.getTime() - new Date(asOf).getTime() > thresholdHours * MS_PER_HOUR;

export const convert = (
  amount: number,
  from: CurrencyCode,
  to: CurrencyCode,
  rates: readonly CurrencyRate[],
  now: Date,
  options: ConvertOptions,
): ConversionResult => {
  if (from === to) {
    return {
      value: roundToDecimals(amount, options.decimals),
      rate: 1,
      asOf: now.toISOString(),
      stale: false,
      noRate: false,
    };
  }

  const match = R.find(rates, (r) => r.fromCode === from && r.toCode === to);
  if (!match) return { value: null, rate: null, asOf: null, stale: false, noRate: true };

  const thresholdHours = isCryptoPair(from, to) ? options.thresholds.cryptoHours : options.thresholds.fiatHours;
  return {
    value: roundToDecimals(amount * match.rate, options.decimals),
    rate: match.rate,
    asOf: match.asOf,
    stale: isStale(match.asOf, now, thresholdHours),
    noRate: false,
  };
};

export const valueAccount = <A extends ValuableBalance>(
  account: A,
  baseCurrency: CurrencyCode,
  rates: readonly CurrencyRate[],
  now: Date,
  baseDecimals: number,
  thresholds: StalenessThresholds,
): A & { converted?: ConvertedValue } => {
  const { value, rate, asOf, stale, noRate } = convert(account.balance, account.currency, baseCurrency, rates, now, {
    decimals: baseDecimals,
    thresholds,
  });
  if (noRate || value === null || rate === null || asOf === null) return account;
  return { ...account, converted: { baseCurrency, value, rate, asOf, stale } };
};

const consolidate = <K>(
  contributions: readonly { key: K; converted?: Pick<ConvertedValue, 'value' | 'asOf' | 'stale'> }[],
  decimals: number,
): { total: number; stale: boolean; asOf: string | null; excludedKeys: K[] } => {
  const [included, excluded] = R.partition(contributions, (c) => c.converted !== undefined);
  const oldest = R.firstBy(included, (c) => new Date(c.converted!.asOf).getTime());
  return {
    total: roundToDecimals(
      R.sumBy(included, (c) => c.converted!.value),
      decimals,
    ),
    stale: included.some((c) => c.converted!.stale),
    asOf: oldest?.converted!.asOf ?? null,
    excludedKeys: excluded.map((c) => c.key),
  };
};

export const consolidateNetWorth = <A extends { id: string; converted?: ConvertedValue }>(
  balances: readonly A[],
  baseCurrency: CurrencyCode,
  baseDecimals: number,
): ConsolidatedNetWorth => {
  const { total, excludedKeys } = consolidate(
    balances.map((b) => ({ key: b.id, converted: b.converted })),
    baseDecimals,
  );
  return { baseCurrency, total, excluded: excludedKeys };
};

export const consolidateInCurrency = (
  amountsByCurrency: readonly CurrencyAmount[],
  target: CurrencyCode,
  rates: readonly CurrencyRate[],
  now: Date,
  thresholds: StalenessThresholds,
  targetDecimals: number,
): ConsolidatedInCurrency => {
  const contributions = amountsByCurrency
    .filter(({ amount }) => amount !== 0)
    .map(({ currency, amount }) => {
      const result = convert(amount, currency, target, rates, now, { decimals: targetDecimals, thresholds });
      return result.noRate
        ? { key: currency, converted: undefined }
        : { key: currency, converted: { value: result.value!, asOf: result.asOf!, stale: result.stale } };
    });
  const { total, stale, asOf, excludedKeys } = consolidate(contributions, targetDecimals);
  return {
    total,
    stale,
    asOf,
    excluded: excludedKeys.map((currency) => ({ currency, reason: ExclusionReason.enum.no_rate })),
  };
};
