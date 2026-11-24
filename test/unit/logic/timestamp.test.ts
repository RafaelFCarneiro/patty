import { describe, expect, it } from 'vitest';
import * as timestamp from '../../../src/logic/timestamp.js';

const INSTANT = '2026-08-10T20:00:00.000Z';

describe('parse', () => {
  it.each(['2026-08-10T17:00:00-03:00', '2026-08-10T17:00:00-0300', '2026-08-10T17:00:00-03', INSTANT])(
    'reads %s as the same instant',
    (text) => {
      expect(timestamp.parse(text).toISOString()).toBe(INSTANT);
    },
  );

  it.each([
    ['2026-08-10T22:00:00+02', '2026-08-10T20:00:00.000Z'],
    ['2026-08-10T22:00:00+0200', '2026-08-10T20:00:00.000Z'],
    ['2026-08-11T01:30:00+0530', '2026-08-10T20:00:00.000Z'],
  ])('normalizes the compact offset in %s', (text, expected) => {
    expect(timestamp.parse(text).toISOString()).toBe(expected);
  });
});

describe('canonical', () => {
  it('is the UTC ISO form with milliseconds', () => {
    expect(timestamp.canonical('2026-08-10T17:00:00-03')).toBe(INSTANT);
    expect(timestamp.canonical('2026-08-10T20:00:00Z')).toBe(INSTANT);
  });
});

describe('hoursExcludingWeekends', () => {
  const hours = (from: string, to: string) => timestamp.hoursExcludingWeekends(new Date(from), new Date(to));

  it('equals elapsed hours within a week', () => {
    expect(hours('2026-08-10T08:00:00Z', '2026-08-14T08:00:00Z')).toBe(96);
  });

  it('skips the weekend from Friday evening to Monday morning', () => {
    expect(hours('2026-08-14T20:00:00Z', '2026-08-17T08:00:00Z')).toBe(4 + 8);
  });

  it('is zero from Saturday to Sunday', () => {
    expect(hours('2026-08-15T06:00:00Z', '2026-08-16T18:00:00Z')).toBe(0);
  });

  it('counts only the weekday part of a window that starts on a weekend', () => {
    expect(hours('2026-08-16T22:00:00Z', '2026-08-17T06:00:00Z')).toBe(6);
  });

  it('skips every weekend over several weeks', () => {
    expect(hours('2026-08-03T00:00:00Z', '2026-08-24T00:00:00Z')).toBe(15 * 24);
  });

  it('is zero for the same instant and negative for a reversed window', () => {
    expect(hours('2026-08-12T12:00:00Z', '2026-08-12T12:00:00Z')).toBe(0);
    expect(hours('2026-08-12T13:00:00Z', '2026-08-12T12:00:00Z')).toBe(-1);
  });

  it('measures instants before the epoch', () => {
    expect(hours('1969-12-26T12:00:00Z', '1969-12-29T12:00:00Z')).toBe(12 + 12);
  });
});

describe('elapsedHours', () => {
  it('counts the weekend', () => {
    expect(timestamp.elapsedHours(new Date('2026-08-14T20:00:00Z'), new Date('2026-08-17T08:00:00Z'))).toBe(60);
  });
});
