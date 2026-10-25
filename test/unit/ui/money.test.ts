import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';
import { CURRENCIES } from '../../../src/diplomat/db/seed/currencies.js';

// ui/money.js is a plain browser-global script (no build step, no module system — matches the rest
// of ui/, see ui/app.js's own header comment) loaded via <script src> in shell.html, so it can't be
// imported here. Loading its source into a minimal sandboxed `window` with node:vm exercises the
// real file instead of a re-implementation, without needing a browser or bundler in the test run.
const MONEY_JS_PATH = fileURLToPath(new URL('../../../ui/money.js', import.meta.url));

type Sandbox = { window: { formatMoney: FormatMoney; __fintrackCurrencies?: unknown } };
type FormatMoney = (value: number, currencyCode: string, opts?: { locale?: string }) => string;

const loadFormatMoney = (currencies?: unknown): FormatMoney => {
  const source = readFileSync(MONEY_JS_PATH, 'utf-8');
  const window: Sandbox['window'] = { formatMoney: (() => '') as unknown as FormatMoney };
  if (currencies !== undefined) window.__fintrackCurrencies = currencies;
  const sandbox = { window, Intl, Number };
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox, { filename: MONEY_JS_PATH });
  return sandbox.window.formatMoney;
};

describe('window.formatMoney (ui/money.js)', () => {
  it('formats fiat via Intl currency mode, byte-for-byte unchanged from the pre-ADR-026 calls', () => {
    const formatMoney = loadFormatMoney();
    expect(formatMoney(1234.5, 'BRL')).toBe(
      new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(1234.5),
    );
    expect(formatMoney(1234.5, 'USD')).toBe(
      new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(1234.5),
    );
  });

  it('never throws for a non-ISO crypto code — including USDC, which a bare Intl call rejects', () => {
    expect(() => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USDC' })).toThrow();
    const formatMoney = loadFormatMoney();
    expect(() => formatMoney(100.123456, 'USDC')).not.toThrow();
    expect(() => formatMoney(0.12345678, 'BTC')).not.toThrow();
  });

  // BTC is 3 letters, so it passes Intl's currency-code syntax check and never throws — a bare
  // Intl call silently flattens it to 2 decimals with no real symbol instead. That's the actual
  // gotcha isIsoCurrency (Intl.supportedValuesOf) exists to catch, beyond the simpler throw/no-throw case.
  it("doesn't silently flatten BTC to 2 decimals the way a bare Intl call does", () => {
    const bareIntlResult = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'BTC' }).format(
      0.12345678,
    );
    expect(bareIntlResult).not.toContain('0.12345678'); // wrong: flattened to 2 decimals — and didn't throw
    expect(bareIntlResult).not.toContain('₿'); // wrong: no real symbol either
    const formatMoney = loadFormatMoney({ BTC: { code: 'BTC', symbol: '₿', name: 'Bitcoin', decimals: 8 } });
    expect(formatMoney(0.12345678, 'BTC')).toBe('₿ 0.12345678');
  });

  it("formats a crypto amount with its own symbol + decimals from currency metadata, not a flat 2", () => {
    const formatMoney = loadFormatMoney({
      BTC: { code: 'BTC', symbol: '₿', name: 'Bitcoin', decimals: 8 },
      USDC: { code: 'USDC', symbol: 'USDC', name: 'USD Coin', decimals: 6 },
    });
    expect(formatMoney(0.12345678, 'BTC')).toBe('₿ 0.12345678');
    expect(formatMoney(100.123456, 'USDC')).toBe('USDC 100.123456');
  });

  it('degrades gracefully (code as symbol, 2 decimals) when metadata has not loaded yet', () => {
    const formatMoney = loadFormatMoney(undefined);
    expect(formatMoney(0.12345678, 'BTC')).toBe('BTC 0.12');
  });

  it('formats MXN and COP in their own market style (es-MX, es-CO) with a symbol distinct from USD', () => {
    const formatMoney = loadFormatMoney();
    const viaIntl = (locale: string, currency: string, symbol: string) =>
      new Intl.NumberFormat(locale, { style: 'currency', currency })
        .formatToParts(1234.5)
        .map((part) => (part.type === 'currency' ? symbol : part.value))
        .join('');
    expect(formatMoney(1234.5, 'MXN')).toBe(viaIntl('es-MX', 'MXN', 'MX$'));
    expect(formatMoney(1234.5, 'COP')).toBe(viaIntl('es-CO', 'COP', 'COL$'));
    expect(formatMoney(1234.5, 'MXN')).toContain('MX$');
    expect(formatMoney(1234.5, 'COP')).toContain('COL$');
    expect(formatMoney(1234.5, 'MXN')).not.toBe(formatMoney(1234.5, 'USD'));
    expect(formatMoney(1234.5, 'MXN', { locale: 'en-US' })).toBe('MX$1,234.50');
  });

  it('leaves BRL and USD formatting unchanged', () => {
    const formatMoney = loadFormatMoney();
    expect(formatMoney(1234.5, 'BRL')).toBe(
      new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(1234.5),
    );
    expect(formatMoney(1234.5, 'USD')).toBe(
      new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(1234.5),
    );
  });

  it.each(['MXN', 'COP'] as const)('uses the same %s symbol as the currency seed', (code) => {
    const seeded = CURRENCIES.find((currency) => currency.code === code);
    expect(loadFormatMoney()(1, code)).toContain(seeded?.symbol);
  });

  it('accepts an explicit locale override (budget.html threads the app locale through)', () => {
    const formatMoney = loadFormatMoney({ BTC: { code: 'BTC', symbol: '₿', name: 'Bitcoin', decimals: 8 } });
    expect(formatMoney(1234.5, 'BRL', { locale: 'en-US' })).toBe(
      new Intl.NumberFormat('en-US', { style: 'currency', currency: 'BRL' }).format(1234.5),
    );
  });
});

// Currency-map arithmetic shared across every dashboard fragment (issue #174) — moved here from
// per-fragment copies (budget.html originally, then comparative/projections/overview.html) so
// there's one implementation to test instead of four. See ui/money.js's own header comment.
type CurrencyMap = Record<string, number>;
type CurrencyHelpers = {
  DEFAULT_CURRENCY: string;
  addMultiCurrency: (map: CurrencyMap, currency: string | undefined, amount: number) => void;
  valueIn: (map: CurrencyMap | undefined, currency: string) => number;
  primaryCurrencyOf: (map: CurrencyMap | undefined) => string;
  magnitudeOf: (map: CurrencyMap | undefined) => number;
  mergeCurrencyMaps: (...maps: Array<CurrencyMap | undefined>) => CurrencyMap;
  formatMultiCurrencyWith: (
    map: CurrencyMap | undefined,
    formatFn: (value: number, currency: string) => string,
    delimiter?: string,
  ) => string;
};

const loadCurrencyHelpers = (): CurrencyHelpers => {
  const source = readFileSync(MONEY_JS_PATH, 'utf-8');
  const window: Record<string, unknown> = { formatMoney: () => '' };
  const sandbox = { window, Intl, Number };
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox, { filename: MONEY_JS_PATH });
  return sandbox.window as unknown as CurrencyHelpers;
};

describe('window.DEFAULT_CURRENCY / addMultiCurrency (ui/money.js)', () => {
  it('defaults an unset currency to DEFAULT_CURRENCY and accumulates repeated calls', () => {
    const { addMultiCurrency, DEFAULT_CURRENCY } = loadCurrencyHelpers();
    const map: CurrencyMap = {};
    addMultiCurrency(map, undefined, 10);
    addMultiCurrency(map, DEFAULT_CURRENCY, 5);
    addMultiCurrency(map, 'USD', 2);
    addMultiCurrency(map, 'USD', 3);

    expect(map).toEqual({ [DEFAULT_CURRENCY]: 15, USD: 5 });
  });

  it('never produces NaN from a non-numeric amount', () => {
    const { addMultiCurrency } = loadCurrencyHelpers();
    const map: CurrencyMap = {};
    addMultiCurrency(map, 'BTC', Number.NaN);
    addMultiCurrency(map, 'BTC', 0.0015);

    expect(map.BTC).toBe(0.0015);
  });
});

describe('window.valueIn (ui/money.js)', () => {
  it('reads a present currency and falls back to 0 for a missing one or an undefined map', () => {
    const { valueIn } = loadCurrencyHelpers();
    expect(valueIn({ BRL: 100 }, 'BRL')).toBe(100);
    expect(valueIn({ BRL: 100 }, 'USD')).toBe(0);
    expect(valueIn(undefined, 'BRL')).toBe(0);
  });
});

describe('window.primaryCurrencyOf (ui/money.js)', () => {
  it('picks BRL when present, regardless of magnitude', () => {
    const { primaryCurrencyOf } = loadCurrencyHelpers();
    expect(primaryCurrencyOf({ BRL: 1, USD: 100000 })).toBe('BRL');
  });

  it('picks alphabetically first among non-BRL currencies', () => {
    const { primaryCurrencyOf } = loadCurrencyHelpers();
    expect(primaryCurrencyOf({ USD: 50, BTC: 0.01 })).toBe('BTC');
  });

  it('ignores zero-valued entries when a non-zero currency is also present', () => {
    const { primaryCurrencyOf } = loadCurrencyHelpers();
    expect(primaryCurrencyOf({ USD: 0, BTC: 0.01 })).toBe('BTC');
  });

  it('falls back to DEFAULT_CURRENCY only for a truly empty (or undefined) map', () => {
    const { primaryCurrencyOf, DEFAULT_CURRENCY } = loadCurrencyHelpers();
    expect(primaryCurrencyOf({})).toBe(DEFAULT_CURRENCY);
    expect(primaryCurrencyOf(undefined)).toBe(DEFAULT_CURRENCY);
  });

  it('still names a currency present with only a zero value, when no other currency exists', () => {
    // Falling back to DEFAULT_CURRENCY here (instead of the one real key present) would silently
    // relabel a zeroed-out USD row as BRL — the zero-value filter only exists to prefer a non-zero
    // currency over a zero one when both are present, not to discard the only currency there is.
    const { primaryCurrencyOf } = loadCurrencyHelpers();
    expect(primaryCurrencyOf({ USD: 0 })).toBe('USD');
  });
});

describe('window.magnitudeOf (ui/money.js)', () => {
  it('sums raw units across currencies — a display-order/boolean heuristic, never a shown number', () => {
    const { magnitudeOf } = loadCurrencyHelpers();
    expect(magnitudeOf({ BRL: 1000, USD: 50, BTC: 0.05 })).toBeCloseTo(1050.05);
  });

  it('returns 0 for an empty or undefined map', () => {
    const { magnitudeOf } = loadCurrencyHelpers();
    expect(magnitudeOf({})).toBe(0);
    expect(magnitudeOf(undefined)).toBe(0);
  });
});

describe('window.mergeCurrencyMaps (ui/money.js)', () => {
  it('adds overlapping currencies instead of the last map silently overwriting the others', () => {
    // Regression test: Object.assign({}, effective, pending) was used at one point to combine a
    // category's effective + pending amounts before sorting — for a category with BRL 1000
    // effective AND BRL 1 pending, Object.assign yields {BRL: 1} (pending overwrites effective)
    // instead of {BRL: 1001}, silently corrupting sort order. mergeCurrencyMaps exists so that
    // combining maps is always additive.
    const { mergeCurrencyMaps } = loadCurrencyHelpers();
    const effective = { BRL: 1000 };
    const pending = { BRL: 1 };

    expect(mergeCurrencyMaps(effective, pending)).toEqual({ BRL: 1001 });
  });

  it('unions currencies that appear in only one of the input maps', () => {
    const { mergeCurrencyMaps } = loadCurrencyHelpers();
    expect(mergeCurrencyMaps({ BRL: 100 }, { USD: 50 }, { BTC: 0.01 })).toEqual({ BRL: 100, USD: 50, BTC: 0.01 });
  });

  it('treats a missing map as empty rather than throwing', () => {
    const { mergeCurrencyMaps } = loadCurrencyHelpers();
    expect(mergeCurrencyMaps(undefined, { BRL: 10 })).toEqual({ BRL: 10 });
  });
});

describe('window.formatMultiCurrencyWith (ui/money.js)', () => {
  const stubFormat = (value: number, currency: string) => `${currency} ${value}`;

  it('formats every non-zero currency, BRL first, joined by the delimiter', () => {
    const { formatMultiCurrencyWith } = loadCurrencyHelpers();
    expect(formatMultiCurrencyWith({ USD: 50, BRL: 100 }, stubFormat)).toBe('BRL 100 / USD 50');
  });

  it('accepts a custom delimiter', () => {
    const { formatMultiCurrencyWith } = loadCurrencyHelpers();
    expect(formatMultiCurrencyWith({ BRL: 100, USD: 50 }, stubFormat, ' | ')).toBe('BRL 100 | USD 50');
  });

  it('skips a zeroed-out currency when a real one is present', () => {
    const { formatMultiCurrencyWith } = loadCurrencyHelpers();
    expect(formatMultiCurrencyWith({ BRL: 100, USD: 0 }, stubFormat)).toBe('BRL 100');
  });

  it('falls back to DEFAULT_CURRENCY zero only for a genuinely empty (or undefined) map', () => {
    const { formatMultiCurrencyWith, DEFAULT_CURRENCY } = loadCurrencyHelpers();
    expect(formatMultiCurrencyWith({}, stubFormat)).toBe(`${DEFAULT_CURRENCY} 0`);
    expect(formatMultiCurrencyWith(undefined, stubFormat)).toBe(`${DEFAULT_CURRENCY} 0`);
  });

  it('names its real currency at zero instead of silently relabeling it as DEFAULT_CURRENCY', () => {
    // Regression test: a USD-only month whose income and expense net to exactly zero produces
    // netBalance = { USD: 0 } — filtering out every zero entry before falling back to
    // formatFn(0, DEFAULT_CURRENCY) would render that as a BRL zero, exactly the kind of
    // currency mislabeling issue #174 exists to eliminate.
    const { formatMultiCurrencyWith } = loadCurrencyHelpers();
    expect(formatMultiCurrencyWith({ USD: 0 }, stubFormat)).toBe('USD 0');
  });

  it('shows every currency present when all of them are zero, rather than picking one', () => {
    const { formatMultiCurrencyWith } = loadCurrencyHelpers();
    expect(formatMultiCurrencyWith({ BRL: 0, USD: 0 }, stubFormat)).toBe('BRL 0 / USD 0');
  });
});
