import { describe, expect, it } from 'vitest';
import {
  CurrencyRateEntitySchema,
  CurrencyRateViewSchema,
  SetExchangeRateSchema,
} from '../../../src/models/currency-rate.js';
import { UtcTimestamp } from '../../../src/models/timestamp.js';

const ACCEPTED = [
  '2026-08-10T12:00:00Z',
  '2026-08-10T12:00:00+02:00',
  '2026-08-10T12:00:00+0200',
  '2026-08-10T12:00:00-03',
];
const REJECTED = [
  '2026-08-10',
  '2026-08-10T12:00:00',
  '2026-13-10T12:00:00+0200',
  'not a date',
  '2026-08-10T12:00:00+02000',
];

const STRICT = ['2026-08-10T12:00:00Z', '2026-08-10T12:00:00.000Z'];
const COMPACT = ['2026-08-10T12:00:00+0200', '2026-08-10T12:00:00-03', '2026-08-10T12:00:00+02:00'];

const entityOf = (asOf: string) => ({
  id: crypto.randomUUID(),
  fromCode: 'USD',
  toCode: 'BRL',
  rate: 5,
  asOf,
  source: null,
  version: 1,
});

describe('rate timestamps', () => {
  it.each(ACCEPTED)('accepts %s on input (as zod 3 did)', (asOf) => {
    expect(SetExchangeRateSchema.safeParse({ from: 'USD', to: 'BRL', rate: 5, asOf }).success).toBe(true);
  });

  it.each(STRICT)('serves %s in the stored entity and in the view as is', (asOf) => {
    expect(CurrencyRateViewSchema.parse({ from: 'USD', to: 'BRL', rate: 5, asOf }).asOf).toBe(asOf);
    expect(CurrencyRateEntitySchema.safeParse(entityOf(asOf)).success).toBe(true);
  });

  it.each(COMPACT)('does not serve the offset %s: the adapter canonicalizes it first', (asOf) => {
    expect(CurrencyRateViewSchema.safeParse({ from: 'USD', to: 'BRL', rate: 5, asOf }).success).toBe(false);
    expect(CurrencyRateEntitySchema.safeParse(entityOf(asOf)).success).toBe(false);
  });

  it.each(REJECTED)('rejects %s', (asOf) => {
    expect(SetExchangeRateSchema.safeParse({ from: 'USD', to: 'BRL', rate: 5, asOf }).success).toBe(false);
  });
});

describe('UtcTimestamp — what PATTY serves', () => {
  it('accepts a Z timestamp and refuses any other offset', () => {
    expect(UtcTimestamp.safeParse('2026-08-10T12:00:00.000Z').success).toBe(true);
    expect(UtcTimestamp.safeParse('2026-08-10T12:00:00Z').success).toBe(true);
    expect(UtcTimestamp.safeParse('2026-08-10T09:00:00-03:00').success).toBe(false);
    expect(UtcTimestamp.safeParse('2026-08-10T09:00:00+0000').success).toBe(false);
  });
});
