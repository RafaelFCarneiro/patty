import { describe, expect, it } from 'vitest';
import * as timestamp from '../../../src/logic/timestamp.js';

const INSTANT = '2026-08-10T20:00:00.000Z';

describe('parseTimestamp', () => {
  it.each(['2026-08-10T17:00:00-03:00', '2026-08-10T17:00:00-0300', '2026-08-10T17:00:00-03', INSTANT])(
    'reads %s as the same instant',
    (text) => {
      expect(timestamp.parseTimestamp(text).toISOString()).toBe(INSTANT);
    },
  );

  it.each([
    ['2026-08-10T22:00:00+02', '2026-08-10T20:00:00.000Z'],
    ['2026-08-10T22:00:00+0200', '2026-08-10T20:00:00.000Z'],
    ['2026-08-11T01:30:00+0530', '2026-08-10T20:00:00.000Z'],
  ])('normalizes the compact offset in %s', (text, expected) => {
    expect(timestamp.parseTimestamp(text).toISOString()).toBe(expected);
  });
});

describe('canonical', () => {
  it('is the UTC ISO form with milliseconds', () => {
    expect(timestamp.canonical('2026-08-10T17:00:00-03')).toBe(INSTANT);
    expect(timestamp.canonical('2026-08-10T20:00:00Z')).toBe(INSTANT);
  });
});
