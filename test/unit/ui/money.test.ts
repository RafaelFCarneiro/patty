import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';

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

  it('accepts an explicit locale override (budget.html threads the app locale through)', () => {
    const formatMoney = loadFormatMoney({ BTC: { code: 'BTC', symbol: '₿', name: 'Bitcoin', decimals: 8 } });
    expect(formatMoney(1234.5, 'BRL', { locale: 'en-US' })).toBe(
      new Intl.NumberFormat('en-US', { style: 'currency', currency: 'BRL' }).format(1234.5),
    );
  });
});
