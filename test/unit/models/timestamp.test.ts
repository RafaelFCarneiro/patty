import { describe, expect, it } from 'vitest';
import { IsoTimestamp } from '../../../src/models/timestamp.js';
import * as timestamp from '../../../src/logic/timestamp.js';

describe('IsoTimestamp', () => {
  it.each([
    '2026-08-10T10:00:00Z',
    '2026-08-10T10:00:00.000+00:00',
    '2026-08-10T07:00:00-03',
    '2026-08-10T07:00:00-0300',
    '0000-01-01T00:00:00Z',
    '9999-12-31T23:59:59.999Z',
  ])('accepts %s', (text) => {
    expect(IsoTimestamp.safeParse(text).success).toBe(true);
  });

  it.each(['2026-08-10', '2026-08-10T10:00:00', 'not a date'])('refuses %s', (text) => {
    expect(IsoTimestamp.safeParse(text).success).toBe(false);
  });

  it.each([
    '9999-12-31T23:59:59-03',
    '9999-12-31T23:59:59-0300',
    '9999-12-31T23:59:59-03:00',
    '0000-01-01T00:00:00+03',
  ])('refuses %s: its UTC instant leaves years 0000–9999', (text) => {
    expect(IsoTimestamp.safeParse(text).success).toBe(false);
  });

  it('everything it accepts has a four-digit-year canonical form that it accepts again', () => {
    const canonical = timestamp.canonical('9999-12-31T23:59:59+03');
    expect(canonical).toBe('9999-12-31T20:59:59.000Z');
    expect(IsoTimestamp.safeParse(canonical).success).toBe(true);
  });
});
