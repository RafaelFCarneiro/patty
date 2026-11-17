import { describe, expect, it } from 'vitest';
import {
  CurrencyRateEntitySchema,
  CurrencyRateViewSchema,
  SetExchangeRateSchema,
} from '../../../src/models/currency-rate.js';

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

describe('rate timestamps', () => {
  it.each(ACCEPTED)('accepts %s on input, in the stored entity and in the view (as zod 3 did)', (asOf) => {
    expect(SetExchangeRateSchema.safeParse({ from: 'USD', to: 'BRL', rate: 5, asOf }).success).toBe(true);
    expect(CurrencyRateViewSchema.parse({ from: 'USD', to: 'BRL', rate: 5, asOf }).asOf).toBe(asOf);
    expect(
      CurrencyRateEntitySchema.safeParse({
        id: crypto.randomUUID(),
        fromCode: 'USD',
        toCode: 'BRL',
        rate: 5,
        asOf,
        source: null,
        version: 1,
      }).success,
    ).toBe(true);
  });

  it.each(REJECTED)('rejects %s', (asOf) => {
    expect(SetExchangeRateSchema.safeParse({ from: 'USD', to: 'BRL', rate: 5, asOf }).success).toBe(false);
  });
});
