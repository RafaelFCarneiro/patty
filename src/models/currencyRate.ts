import { z } from 'zod';
import { Id } from './id.js';
import { CurrencyCode } from './money.js';
import { withPersistenceMeta } from '../effects/persistable.js';
import type { ValidationError } from './error.js';

// Entity tag for this aggregate's `Persistable`s.
export const CURRENCY_RATE_ENTITY_TAG = 'currency_rate';

/** Agent/scheduler-supplied external data (ADR-026 Phase 2) — decoded at the boundary like any
 *  other input, never treated as authoritative beyond its own `asOf`. */
export const SetExchangeRateSchema = z.object({
  from: CurrencyCode.describe('Base currency — 1 unit of this equals `rate` units of `to`'),
  to: CurrencyCode.describe('Quote currency — the unit `rate` is expressed in'),
  rate: z.number().positive().describe('1 unit of `from` = `rate` units of `to`, as of `asOf`'),
  asOf: z.string().datetime({ offset: true }).describe('ISO 8601 timestamp this rate was observed/sourced'),
  source: z.string().min(1).optional().describe('Free-text provenance, e.g. "PTAX", "coingecko"'),
});
export type SetExchangeRateInput = z.infer<typeof SetExchangeRateSchema>;

/** `from`/`to` are this module's own vocabulary for the `from_code`/`to_code` columns —
 *  `adapters/currencyRates.ts` maps the rename. */
export const CurrencyRateSchema = z.object({
  id: Id.describe('Unique exchange rate identifier'),
  fromCode: CurrencyCode.describe('Base currency — 1 unit of this equals `rate` units of toCode'),
  toCode: CurrencyCode.describe('Quote currency — the unit `rate` is expressed in'),
  rate: z.number().positive().describe('1 unit of fromCode = `rate` units of toCode, as of `asOf`'),
  asOf: z
    .string()
    .datetime({ offset: true })
    .describe('ISO 8601 timestamp this rate was observed/sourced (agent-supplied)'),
  source: z
    .string()
    .min(1)
    .nullable()
    .describe('Free-text provenance (e.g. "PTAX", "coingecko"), or null if unspecified'),
});
export type CurrencyRate = z.infer<typeof CurrencyRateSchema>;

// `CurrencyRate` plus the optimistic-concurrency `version` token. Never sent over the wire.
export const CurrencyRateEntitySchema = withPersistenceMeta(CurrencyRateSchema);
export type CurrencyRateEntity = z.infer<typeof CurrencyRateEntitySchema>;

/** Read projection actually returned to callers — `from`/`to` instead of the internal
 *  `fromCode`/`toCode`, mirroring `BudgetView`'s `limit` rename (models/budget.ts). No `id`/`version`:
 *  a rate is addressed by its (from, to) pair, never by id, from the caller's perspective. */
export const CurrencyRateViewSchema = z.object({
  from: CurrencyCode.describe('Base currency'),
  to: CurrencyCode.describe('Quote currency'),
  rate: z.number().positive().describe('1 unit of `from` = `rate` units of `to`, as of `asOf`'),
  asOf: z.string().datetime({ offset: true }).describe('ISO 8601 timestamp this rate was observed/sourced'),
  source: z.string().min(1).optional().describe('Free-text provenance, e.g. "PTAX", "coingecko"'),
});
export type CurrencyRateView = z.infer<typeof CurrencyRateViewSchema>;

/** A single balance's read-time valuation against a base currency (ADR-026 Phase 3) — omitted by
 *  the caller building the response when unconvertible (no rate on file for the pair). */
export const ConvertedValueSchema = z.object({
  baseCurrency: CurrencyCode.describe('The currency this value is expressed in'),
  value: z.number().describe('Amount converted to baseCurrency, rounded to its own decimals'),
  rate: z.number().positive().describe('Exchange rate applied (1 when the source currency already is baseCurrency)'),
  asOf: z.string().datetime({ offset: true }).describe('When the applied rate was observed/sourced'),
  stale: z.boolean().describe('True when the rate is older than its class staleness threshold'),
});
export type ConvertedValue = z.infer<typeof ConvertedValueSchema>;

/** Why a currency was left out of a `displayCurrency` grand total — currently the only reason is a
 *  missing rate to the target; a named enum keeps the wire value out of raw string literals, same
 *  as any other domain vocabulary. */
export const ExclusionReason = z.enum(['no_rate']);
export type ExclusionReason = z.infer<typeof ExclusionReason>;

export const ExcludedCurrencySchema = z.object({
  currency: CurrencyCode.describe('Currency left out of the converted total'),
  reason: ExclusionReason.describe('Why this currency could not be converted to the display currency'),
});
export type ExcludedCurrency = z.infer<typeof ExcludedCurrencySchema>;

/** A converted grand total across a per-currency read's own currencies — the generalized
 *  `consolidatedNetWorth` shape, reusable by any per-currency read that wants an opt-in
 *  converted total on top of its unchanged per-currency lines. */
export const ConvertedTotalSchema = z.object({
  displayCurrency: CurrencyCode.describe('Currency the grand total is expressed in'),
  total: z.number().describe('Sum of every convertible per-currency amount, rounded to displayCurrency decimals'),
  stale: z.boolean().describe('True when any contributing rate is older than its class staleness threshold'),
  asOf: z
    .string()
    .datetime({ offset: true })
    .nullable()
    .describe('Oldest contributing rate timestamp, or null when nothing was converted'),
  excluded: z.array(ExcludedCurrencySchema).describe('Currencies with no rate to displayCurrency, left out of total'),
});
export type ConvertedTotal = z.infer<typeof ConvertedTotalSchema>;

export type CurrencyRateError = ValidationError;

export const currencyRateErrors = {
  samePair: {
    code: 'validation',
    issues: ['from and to currencies must differ'],
  } satisfies CurrencyRateError,
};
