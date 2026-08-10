import { describe, expect, it } from 'vitest';
import { canAutoSwitchLocale, localeToBaseCurrency, resolveBaseCurrency } from '../../../src/logic/locale.js';
import { localeErrors, Locale, LocaleSource } from '../../../src/models/locale.js';
import { CurrencyCode } from '../../../src/models/money.js';

describe('canAutoSwitchLocale', () => {
  it('allows inferred change when current source is default', () => {
    expect(canAutoSwitchLocale('inferred', { localeSource: LocaleSource.enum.default }, true)).toBe(true);
  });

  it('allows inferred change when current source is inferred', () => {
    expect(canAutoSwitchLocale('inferred', { localeSource: LocaleSource.enum.inferred }, true)).toBe(true);
  });

  it('blocks inferred change when current source is explicit and locale would change', () => {
    expect(canAutoSwitchLocale('inferred', { localeSource: LocaleSource.enum.explicit }, true)).toBe(false);
  });

  it('allows inferred when explicit but locale would not change (no-op)', () => {
    expect(canAutoSwitchLocale('inferred', { localeSource: LocaleSource.enum.explicit }, false)).toBe(true);
  });

  it('allows explicit change regardless of current source', () => {
    expect(canAutoSwitchLocale('explicit', { localeSource: LocaleSource.enum.explicit }, true)).toBe(true);
  });

  it('allows when current is null (first-time set)', () => {
    expect(canAutoSwitchLocale('inferred', null, true)).toBe(true);
  });
});

describe('localeErrors', () => {
  it('explicitLocaleBlock is a validation error', () => {
    expect(localeErrors.explicitLocaleBlock.code).toBe('validation');
    expect(localeErrors.explicitLocaleBlock.issues[0]).toContain('explicit');
  });
});

describe('localeToBaseCurrency', () => {
  it('maps pt to BRL', () => {
    expect(localeToBaseCurrency(Locale.enum.pt)).toBe(CurrencyCode.enum.BRL);
  });

  it('maps en to USD', () => {
    expect(localeToBaseCurrency(Locale.enum.en)).toBe(CurrencyCode.enum.USD);
  });

  it('maps es to USD', () => {
    expect(localeToBaseCurrency(Locale.enum.es)).toBe(CurrencyCode.enum.USD);
  });
});

describe('resolveBaseCurrency', () => {
  it('prefers the stored explicit override over the locale-derived default', () => {
    expect(resolveBaseCurrency(CurrencyCode.enum.USDC, Locale.enum.pt)).toBe(CurrencyCode.enum.USDC);
  });

  it('derives from locale when stored is null', () => {
    expect(resolveBaseCurrency(null, Locale.enum.pt)).toBe(CurrencyCode.enum.BRL);
  });

  it('derives from locale when stored is undefined', () => {
    expect(resolveBaseCurrency(undefined, Locale.enum.en)).toBe(CurrencyCode.enum.USD);
  });
});
