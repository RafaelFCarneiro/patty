import { describe, expect, it } from 'vitest';
import { isStale } from '../../../src/logic/staleness.js';
import { StalenessClass } from '../../../src/models/timestamp.js';

const { fiat_rate, crypto_rate, market_price, manual_price } = StalenessClass.enum;

const WEDNESDAY_NOON = new Date('2026-08-12T12:00:00.000Z');
const HOUR_MS = 60 * 60 * 1000;
const hoursBefore = (hours: number, from = WEDNESDAY_NOON) => new Date(from.getTime() - hours * HOUR_MS).toISOString();

describe('isStale', () => {
  it.each([fiat_rate, crypto_rate, market_price, manual_price])('%s: false exactly at the threshold', (kind) => {
    expect(isStale(kind, hoursBefore(24), WEDNESDAY_NOON, 24)).toBe(false);
  });

  it.each([fiat_rate, crypto_rate, market_price, manual_price])('%s: true just past the threshold', (kind) => {
    expect(isStale(kind, hoursBefore(24 + 1 / 3600), WEDNESDAY_NOON, 24)).toBe(true);
  });

  it.each(['-03', '-0300'])('reads a compact offset (%s) as its real instant', (offset) => {
    expect(isStale(crypto_rate, `2026-08-12T08:00:00${offset}`, WEDNESDAY_NOON, 24)).toBe(false);
    expect(isStale(crypto_rate, `2026-08-11T08:00:00${offset}`, WEDNESDAY_NOON, 24)).toBe(true);
  });

  it('a market price posted Friday 20:00Z is fresh through Monday 19:00Z and stale Monday 21:00Z', () => {
    const friday = '2026-08-14T20:00:00.000Z';
    expect(isStale(market_price, friday, new Date('2026-08-17T19:00:00.000Z'), 24)).toBe(false);
    expect(isStale(market_price, friday, new Date('2026-08-17T21:00:00.000Z'), 24)).toBe(true);
  });

  it('a manual price keeps elapsed hours over a weekend', () => {
    const friday = '2026-08-14T20:00:00.000Z';
    expect(isStale(manual_price, friday, new Date('2026-08-17T19:00:00.000Z'), 24)).toBe(true);
  });
});
