import type { Result } from 'neverthrow';
import * as R from 'remeda';
import { CurrencyCode } from '../models/money.js';
import type { ConvertedValue, CurrencyRate, CurrencyRateView, SetExchangeRateInput } from '../models/currencyRate.js';
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

/** The shape `valueAccount`/`consolidateNetWorth` need from a balance — deliberately minimal so
 *  they stay generic over whatever concrete balance type the account controller passes in. */
export type ValuableBalance = { id: string; currency: CurrencyCode; balance: number };

/** Attaches `converted` (base-currency valuation of `balance`) to a balance whose currency has a
 *  known rate to `baseCurrency` — `convert`'s own identity case covers `currency === baseCurrency`
 *  (rate 1, never stale). Omits `converted` entirely on a missing pair rather than fabricating a
 *  value (ADR-026) — the caller never sees a `noRate` marker on the wire, just absence. */
export const valueAccount = <A extends ValuableBalance>(
  account: A,
  baseCurrency: CurrencyCode,
  rates: readonly CurrencyRate[],
  now: Date,
  baseDecimals: number,
  thresholds: StalenessThresholds,
): A & { converted?: ConvertedValue } => {
  const result = convert(account.balance, account.currency, baseCurrency, rates, now, {
    decimals: baseDecimals,
    thresholds,
  });
  if (result.noRate) return account;
  return {
    ...account,
    converted: { baseCurrency, value: result.value!, rate: result.rate!, asOf: result.asOf!, stale: result.stale },
  };
};

export type ConsolidatedNetWorth = { baseCurrency: CurrencyCode; total: number; excluded: string[] };

/** Sums every valued balance's `converted.value`; a balance with no `converted` block (no rate on
 *  file) is listed in `excluded` and left out of `total` rather than being silently dropped. */
export const consolidateNetWorth = <A extends { id: string; converted?: ConvertedValue }>(
  balances: readonly A[],
  baseCurrency: CurrencyCode,
  baseDecimals: number,
): ConsolidatedNetWorth => {
  const [included, excluded] = R.partition(balances, (b) => b.converted !== undefined);
  return {
    baseCurrency,
    total: roundToDecimals(R.sumBy(included, (b) => b.converted!.value), baseDecimals),
    excluded: excluded.map((b) => b.id),
  };
};
