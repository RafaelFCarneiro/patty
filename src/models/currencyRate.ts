import { z } from 'zod';
import { Id } from './id.js';
import { CurrencyCode } from './money.js';
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
export const CurrencyRateEntitySchema = CurrencyRateSchema.extend({
  version: z.number().int().nonnegative().describe('Optimistic-concurrency token; internal, never on wire/out'),
});
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

export type CurrencyRateError = ValidationError;

export const currencyRateErrors = {
  samePair: {
    code: 'validation',
    issues: ['from and to currencies must differ'],
  } satisfies CurrencyRateError,
};
