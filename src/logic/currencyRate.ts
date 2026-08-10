import type { Result } from 'neverthrow';
import * as R from 'remeda';
import { CurrencyCode } from '../models/money.js';
import type { CurrencyRate, CurrencyRateView, SetExchangeRateInput } from '../models/currencyRate.js';
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

// ─── Read-time valuation (pure; no consumer wired yet — ADR-026 Phase 3) ───────────────────────

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
