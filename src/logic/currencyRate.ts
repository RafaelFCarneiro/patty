import type { Result } from 'neverthrow';
import * as R from 'remeda';
import { CurrencyCode } from '../models/money.js';
import { ExclusionReason } from '../models/currencyRate.js';
import type {
  ConvertedTotal,
  ConvertedValue,
  CurrencyRate,
  CurrencyRateView,
  SetExchangeRateInput,
} from '../models/currencyRate.js';
import { roundToDecimals } from './money.js';

// ─── Bulk write shaping (set_exchange_rates) ───────────────────────────────────────────────────

/** One `set_exchange_rates` item's outcome — generic over the error type like
 *  `logic/transaction.ts`'s `BulkItemResult`, so this file never imports `AppError` (diplomat edge
 *  instantiates it in `adapters/currencyRates.ts`). */
export type CurrencyRateBulkItem<E = unknown> =
  { status: 'ok'; rate: CurrencyRateView } | { status: 'error'; from: CurrencyCode; to: CurrencyCode; error: E };

export const toBulkItem = <E>(
  input: SetExchangeRateInput,
  result: Result<CurrencyRateView, E>,
): CurrencyRateBulkItem<E> =>
  result.match(
    (rate) => ({ status: 'ok', rate }),
    (error) => ({ status: 'error', from: input.from, to: input.to, error }),
  );

/** `outcomes[i]` must correspond to `items[i]` — `runEffectsSequence`'s return is positional. */
export const buildBulkResult = <E>(
  items: readonly SetExchangeRateInput[],
  outcomes: readonly Result<CurrencyRateView, E>[],
): CurrencyRateBulkItem<E>[] =>
  R.pipe(
    R.zip(items, outcomes),
    R.map(([input, outcome]) => toBulkItem(input, outcome)),
  );

// ─── Read-time valuation (pure; consumer: get_account_balances, ADR-026 Phase 3) ───────────────

/** Currencies that move fast enough to need the tighter staleness window (ADR-026) — a pair
 *  touching either one on either side uses it, even when converting into/out of fiat. */
const CRYPTO_CURRENCIES: ReadonlySet<CurrencyCode> = new Set([CurrencyCode.enum.USDC, CurrencyCode.enum.BTC]);

export const isCryptoPair = (from: CurrencyCode, to: CurrencyCode): boolean =>
  CRYPTO_CURRENCIES.has(from) || CRYPTO_CURRENCIES.has(to);

/** Staleness thresholds, per class — sourced from config.ts by the controller; logic never reads
 *  env/config itself (docs/diplomatic-architecture.md). */
export type StalenessThresholds = { fiatHours: number; cryptoHours: number };

const MS_PER_HOUR = 60 * 60 * 1000;

export const isStale = (asOf: string, now: Date, thresholdHours: number): boolean =>
  now.getTime() - new Date(asOf).getTime() > thresholdHours * MS_PER_HOUR;

/** amount × rate, staleness/missing-rate aware — never fabricates a value (ADR-026). `from === to`
 *  is always identity: rate 1, never stale, independent of `rates` (even an empty list). A missing
 *  pair reports `noRate: true` with every other field `null` rather than guessing. */
export type ConversionResult = {
  value: number | null;
  rate: number | null;
  asOf: string | null;
  stale: boolean;
  noRate: boolean;
};

export type ConvertOptions = { decimals: number; thresholds: StalenessThresholds };

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

// ─── Account balance valuation (ADR-026 Phase 3, ADR-028 controller-orchestrated) ──────────────

export type ValuableBalance = { id: string; currency: CurrencyCode; balance: number };

/** Omits `converted` entirely on a missing rate rather than fabricating a value or exposing
 *  `convert`'s `noRate` marker on the wire (ADR-026). */
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

export type ConsolidatedNetWorth = { baseCurrency: CurrencyCode; total: number; excluded: string[] };

/** Shared core for both consolidation shapes below: sum every already-converted contribution,
 *  round to the target decimals, and partition out the ones with nothing to sum (`converted`
 *  undefined) by their own key — an account id for `consolidateNetWorth`, a `CurrencyCode` for
 *  `consolidateInCurrency`. `asOf` is the oldest (least fresh) contributing timestamp, the same
 *  worst-case instinct as `stale` (true if ANY contribution is stale) — a total is only as
 *  current as its stalest input. */
const consolidate = <K>(
  contributions: readonly { key: K; converted?: Pick<ConvertedValue, 'value' | 'asOf' | 'stale'> }[],
  decimals: number,
): { total: number; stale: boolean; asOf: string | null; excludedKeys: K[] } => {
  const [included, excluded] = R.partition(contributions, (c) => c.converted !== undefined);
  const oldest = R.firstBy(included, (c) => new Date(c.converted!.asOf).getTime());
  return {
    total: roundToDecimals(R.sumBy(included, (c) => c.converted!.value), decimals),
    stale: included.some((c) => c.converted!.stale),
    asOf: oldest?.converted!.asOf ?? null,
    excludedKeys: excluded.map((c) => c.key),
  };
};

/** A balance with no `converted` block is listed in `excluded`, not silently dropped from the total. */
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

// ─── Read-side grand totals across a per-currency read's own currencies ─────────────────────────

/** One per-currency amount to fold into a `displayCurrency` grand total — at most one entry per
 *  currency, e.g. a spending summary's per-currency `expenses`. */
export type CurrencyAmount = { currency: CurrencyCode; amount: number };

export type ConsolidatedInCurrency = Omit<ConvertedTotal, 'displayCurrency'>;

/** Generalizes `consolidateNetWorth`: converts each per-currency amount against `rates` itself
 *  (rather than taking pre-converted items), sums the convertible ones, and never fabricates a
 *  value for a currency with no rate to `target` — it is listed in `excluded` instead. */
export const consolidateInCurrency = (
  amountsByCurrency: readonly CurrencyAmount[],
  target: CurrencyCode,
  rates: readonly CurrencyRate[],
  now: Date,
  thresholds: StalenessThresholds,
  targetDecimals: number,
): ConsolidatedInCurrency => {
  const contributions = amountsByCurrency.map(({ currency, amount }) => {
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
