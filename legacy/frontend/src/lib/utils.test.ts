import { describe, it, expect } from 'vitest';
import { cn, formatBRL, MONTH_NAMES, pieColor, sumBy } from './utils';

describe('cn', () => {
  it('joins class strings', () => {
    expect(cn('foo', 'bar')).toBe('foo bar');
  });

  it('filters falsy values', () => {
    expect(cn('foo', false && 'bar', undefined, 'baz')).toBe('foo baz');
  });

  it('resolves tailwind conflicts — last class wins', () => {
    expect(cn('text-red-500', 'text-blue-500')).toBe('text-blue-500');
  });
});

describe('formatBRL', () => {
  it('formats a value with the R$ currency symbol', () => {
    expect(formatBRL(1000)).toContain('R$');
  });

  it('uses pt-BR thousands and decimal separators', () => {
    const result = formatBRL(1234.56);
    expect(result).toContain('1.234');
    expect(result).toContain(',56');
  });

  it('formats zero', () => {
    expect(formatBRL(0)).toContain('0,00');
  });
});

describe('MONTH_NAMES', () => {
  it('contains exactly 12 months', () => {
    expect(MONTH_NAMES).toHaveLength(12);
  });

  it('starts with Janeiro and ends with Dezembro', () => {
    expect(MONTH_NAMES[0]).toBe('Janeiro');
    expect(MONTH_NAMES[11]).toBe('Dezembro');
  });
});

describe('pieColor', () => {
  it('returns a hex color string', () => {
    expect(pieColor(0)).toMatch(/^#[0-9a-f]{6}$/i);
  });

  it('wraps around after the 10-color palette', () => {
    expect(pieColor(0)).toBe(pieColor(10));
    expect(pieColor(3)).toBe(pieColor(13));
  });
});

describe('sumBy', () => {
  it('sums values by key across an array of objects', () => {
    const items = [{ amount: 100 }, { amount: 200 }, { amount: 50 }];
    expect(sumBy('amount')(items)).toBe(350);
  });

  it('returns 0 for an empty array', () => {
    expect(sumBy('amount')([])).toBe(0);
  });
});
