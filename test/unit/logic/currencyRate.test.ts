import { err, ok } from 'neverthrow';
import { describe, expect, it } from 'vitest';
import {
  buildBulkResult,
  consolidateInCurrency,
  consolidateNetWorth,
  convert,
  isCryptoPair,
  isStale,
  toBulkItem,
  valueAccount,
  type ValuableBalance,
} from '../../../src/logic/currencyRate.js';
import { CurrencyCode } from '../../../src/models/money.js';
import type { CurrencyRate, CurrencyRateView, SetExchangeRateInput } from '../../../src/models/currencyRate.js';

const { BRL, USD, USDC, BTC } = CurrencyCode.enum;

const rate = (overrides: Partial<CurrencyRate> = {}): CurrencyRate => ({
  id: 'rate-1',
  fromCode: USD,
  toCode: BRL,
  rate: 5,
  asOf: '2026-08-10T12:00:00.000Z',
  source: null,
  ...overrides,
});

const OPTIONS = { decimals: 2, thresholds: { fiatHours: 24, cryptoHours: 1 } };
const NOW = new Date('2026-08-10T12:00:00.000Z');

describe('isCryptoPair', () => {
  it('is false for a pure fiat pair', () => {
    expect(isCryptoPair(USD, BRL)).toBe(false);
  });

  it('is true when the from side is crypto', () => {
    expect(isCryptoPair(BTC, USD)).toBe(true);
  });

  it('is true when the to side is crypto', () => {
    expect(isCryptoPair(USD, USDC)).toBe(true);
  });

  it('is true when both sides are crypto', () => {
    expect(isCryptoPair(BTC, USDC)).toBe(true);
  });
});

describe('isStale', () => {
  it('is false exactly at the threshold boundary', () => {
    const asOf = new Date(NOW.getTime() - 24 * 60 * 60 * 1000).toISOString();
    expect(isStale(asOf, NOW, 24)).toBe(false);
  });

  it('is true just past the threshold boundary', () => {
    const asOf = new Date(NOW.getTime() - 24 * 60 * 60 * 1000 - 1).toISOString();
    expect(isStale(asOf, NOW, 24)).toBe(true);
  });

  it('is false for a fresh timestamp', () => {
    expect(isStale(NOW.toISOString(), NOW, 24)).toBe(false);
  });
});

describe('convert', () => {
  it('identity: from === to always converts at rate 1, never stale, independent of rates', () => {
    const result = convert(100, USD, USD, [], NOW, OPTIONS);
    expect(result).toEqual({ value: 100, rate: 1, asOf: NOW.toISOString(), stale: false, noRate: false });
  });

  it('identity rounds to the target currency decimals', () => {
    const result = convert(1.005, BTC, BTC, [], NOW, { ...OPTIONS, decimals: 8 });
    expect(result.value).toBe(1.005);
    expect(result.noRate).toBe(false);
  });

  it('missing pair reports noRate, never fabricating a value', () => {
    const result = convert(100, USD, BRL, [], NOW, OPTIONS);
    expect(result).toEqual({ value: null, rate: null, asOf: null, stale: false, noRate: true });
  });

  it('converts amount * rate and rounds to the target decimals', () => {
    const result = convert(10, USD, BRL, [rate({ rate: 5.123456 })], NOW, OPTIONS);
    expect(result.value).toBe(51.23);
    expect(result.rate).toBe(5.123456);
    expect(result.noRate).toBe(false);
  });

  it('rounds a crypto target to its own (non-fiat) decimals rather than flattening to 2', () => {
    const rates = [rate({ fromCode: USD, toCode: BTC, rate: 0.00002 })];
    const result = convert(100, USD, BTC, rates, NOW, { ...OPTIONS, decimals: 8 });
    expect(result.value).toBe(0.002);
  });

  it('a fiat pair uses the fiat threshold: fresh just inside 24h is not stale', () => {
    const asOf = new Date(NOW.getTime() - 23 * 60 * 60 * 1000).toISOString();
    const result = convert(10, USD, BRL, [rate({ asOf })], NOW, OPTIONS);
    expect(result.stale).toBe(false);
  });

  it('a fiat pair uses the fiat threshold: stale just past 24h', () => {
    const asOf = new Date(NOW.getTime() - 25 * 60 * 60 * 1000).toISOString();
    const result = convert(10, USD, BRL, [rate({ asOf })], NOW, OPTIONS);
    expect(result.stale).toBe(true);
  });

  it('a pair touching crypto uses the tighter crypto threshold, even converting into fiat', () => {
    const asOf = new Date(NOW.getTime() - 2 * 60 * 60 * 1000).toISOString();
    const rates = [rate({ fromCode: BTC, toCode: USD, rate: 60000, asOf })];
    // 2h old: within the 24h fiat window but past the 1h crypto window.
    const result = convert(1, BTC, USD, rates, NOW, OPTIONS);
    expect(result.stale).toBe(true);
  });

  it('a crypto pair fresh within 1h is not stale', () => {
    const asOf = new Date(NOW.getTime() - 30 * 60 * 1000).toISOString();
    const rates = [rate({ fromCode: BTC, toCode: USD, rate: 60000, asOf })];
    const result = convert(1, BTC, USD, rates, NOW, OPTIONS);
    expect(result.stale).toBe(false);
  });

  it('only matches the exact (from, to) pair, not its inverse', () => {
    const rates = [rate({ fromCode: USD, toCode: BRL, rate: 5 })];
    const result = convert(10, BRL, USD, rates, NOW, OPTIONS);
    expect(result.noRate).toBe(true);
  });
});

describe('valueAccount / consolidateNetWorth (ADR-026 Phase 3, ADR-028 controller-orchestrated)', () => {
  const balance = (overrides: Partial<ValuableBalance> = {}): ValuableBalance => ({
    id: 'acc-1',
    currency: USD,
    balance: 100,
    ...overrides,
  });

  it('valueAccount: identity when the balance is already in the base currency — rate 1, never stale', () => {
    const valued = valueAccount(balance(), USD, [], NOW, 2, OPTIONS.thresholds);
    expect(valued.converted).toEqual({ baseCurrency: USD, value: 100, rate: 1, asOf: NOW.toISOString(), stale: false });
  });

  it('valueAccount: cross-currency with a rate on file converts and rounds to the base decimals', () => {
    const rates = [rate({ fromCode: BRL, toCode: USD, rate: 0.2 })];
    const valued = valueAccount(balance({ currency: BRL, balance: 100 }), USD, rates, NOW, 2, OPTIONS.thresholds);
    expect(valued.converted).toEqual({
      baseCurrency: USD,
      value: 20,
      rate: 0.2,
      asOf: NOW.toISOString(),
      stale: false,
    });
  });

  it('valueAccount: a negative balance (e.g. a credit-card liability) converts with the sign preserved', () => {
    const rates = [rate({ fromCode: BRL, toCode: USD, rate: 0.2 })];
    const valued = valueAccount(balance({ currency: BRL, balance: -500 }), USD, rates, NOW, 2, OPTIONS.thresholds);
    expect(valued.converted).toEqual({
      baseCurrency: USD,
      value: -100,
      rate: 0.2,
      asOf: NOW.toISOString(),
      stale: false,
    });
  });

  it('valueAccount: a missing rate omits converted entirely rather than fabricating a value', () => {
    const valued = valueAccount(balance({ currency: BRL }), USD, [], NOW, 2, OPTIONS.thresholds);
    expect(valued.converted).toBeUndefined();
    expect(valued).toEqual(balance({ currency: BRL }));
  });

  it('valueAccount: a stale rate still converts, flagged', () => {
    const staleAsOf = new Date(NOW.getTime() - 25 * 60 * 60 * 1000).toISOString();
    const rates = [rate({ fromCode: BRL, toCode: USD, rate: 0.2, asOf: staleAsOf })];
    const valued = valueAccount(balance({ currency: BRL }), USD, rates, NOW, 2, OPTIONS.thresholds);
    expect(valued.converted?.stale).toBe(true);
  });

  it('consolidateNetWorth: sums every included converted value, rounded to the base decimals', () => {
    const valuedAccounts = [
      valueAccount(balance({ id: 'acc-usd', currency: USD, balance: 100 }), USD, [], NOW, 2, OPTIONS.thresholds),
      valueAccount(
        balance({ id: 'acc-brl', currency: BRL, balance: 500 }),
        USD,
        [rate({ fromCode: BRL, toCode: USD, rate: 0.2 })],
        NOW,
        2,
        OPTIONS.thresholds,
      ),
    ];
    expect(consolidateNetWorth(valuedAccounts, USD, 2)).toEqual({ baseCurrency: USD, total: 200, excluded: [] });
  });

  it('consolidateNetWorth: a negative (liability) balance offsets positive ones with the correct sign', () => {
    const valuedAccounts = [
      valueAccount(balance({ id: 'acc-usd', currency: USD, balance: 100 }), USD, [], NOW, 2, OPTIONS.thresholds),
      valueAccount(
        balance({ id: 'acc-card', currency: BRL, balance: -500 }),
        USD,
        [rate({ fromCode: BRL, toCode: USD, rate: 0.2 })],
        NOW,
        2,
        OPTIONS.thresholds,
      ),
    ];
    expect(consolidateNetWorth(valuedAccounts, USD, 2)).toEqual({ baseCurrency: USD, total: 0, excluded: [] });
  });

  it('consolidateNetWorth: excludes accounts with no converted value from the total, but still lists their id', () => {
    const valuedAccounts = [
      valueAccount(balance({ id: 'acc-usd', currency: USD, balance: 100 }), USD, [], NOW, 2, OPTIONS.thresholds),
      valueAccount(balance({ id: 'acc-btc', currency: BTC, balance: 1 }), USD, [], NOW, 2, OPTIONS.thresholds),
    ];
    expect(consolidateNetWorth(valuedAccounts, USD, 2)).toEqual({
      baseCurrency: USD,
      total: 100,
      excluded: ['acc-btc'],
    });
  });

  it('consolidateNetWorth: an empty list totals 0 with nothing excluded', () => {
    expect(consolidateNetWorth([], USD, 2)).toEqual({ baseCurrency: USD, total: 0, excluded: [] });
  });
});

describe('consolidateInCurrency', () => {
  const amount = (currency: CurrencyCode, value: number) => ({ currency, amount: value });

  it('target === source is identity: converts at rate 1, asOf = now, never stale', () => {
    const result = consolidateInCurrency([amount(USD, 100)], USD, [], NOW, OPTIONS.thresholds, 2);
    expect(result).toEqual({ total: 100, stale: false, asOf: NOW.toISOString(), excluded: [] });
  });

  it('mixed fiat + crypto: converts each against its own rate and sums, rounded to the target decimals', () => {
    const rates = [
      rate({ fromCode: BRL, toCode: USD, rate: 0.2, asOf: NOW.toISOString() }),
      rate({ fromCode: BTC, toCode: USD, rate: 60000, asOf: NOW.toISOString() }),
    ];
    const result = consolidateInCurrency(
      [amount(BRL, 500), amount(BTC, 0.01), amount(USD, 50)],
      USD,
      rates,
      NOW,
      OPTIONS.thresholds,
      2,
    );
    // BRL: 500 * 0.2 = 100; BTC: 0.01 * 60000 = 600; USD: 50 (identity) → 750
    expect(result.total).toBe(750);
    expect(result.excluded).toEqual([]);
    expect(result.stale).toBe(false);
  });

  it('a currency with no rate to the target is excluded (not fabricated) and listed with its reason', () => {
    const rates = [rate({ fromCode: BRL, toCode: USD, rate: 0.2, asOf: NOW.toISOString() })];
    const result = consolidateInCurrency(
      [amount(BRL, 500), amount(BTC, 1)],
      USD,
      rates,
      NOW,
      OPTIONS.thresholds,
      2,
    );
    expect(result.total).toBe(100);
    expect(result.excluded).toEqual([{ currency: BTC, reason: 'no_rate' }]);
  });

  it('stale is true iff ANY contributing rate is stale, at the per-class threshold boundary', () => {
    const freshFiat = new Date(NOW.getTime() - 23 * 60 * 60 * 1000).toISOString(); // within 24h fiat window
    const staleCrypto = new Date(NOW.getTime() - 2 * 60 * 60 * 1000).toISOString(); // past 1h crypto window
    const rates = [
      rate({ fromCode: BRL, toCode: USD, rate: 0.2, asOf: freshFiat }),
      rate({ fromCode: BTC, toCode: USD, rate: 60000, asOf: staleCrypto }),
    ];
    const result = consolidateInCurrency(
      [amount(BRL, 100), amount(BTC, 1)],
      USD,
      rates,
      NOW,
      OPTIONS.thresholds,
      2,
    );
    expect(result.stale).toBe(true);
  });

  it('stale is false when every contributing rate is fresh', () => {
    const rates = [rate({ fromCode: BRL, toCode: USD, rate: 0.2, asOf: NOW.toISOString() })];
    const result = consolidateInCurrency([amount(BRL, 100)], USD, rates, NOW, OPTIONS.thresholds, 2);
    expect(result.stale).toBe(false);
  });

  it('asOf reflects the oldest contributing rate — the total is only as fresh as its stalest input', () => {
    const older = new Date(NOW.getTime() - 10 * 60 * 60 * 1000).toISOString();
    const newer = new Date(NOW.getTime() - 1 * 60 * 60 * 1000).toISOString();
    const rates = [
      rate({ fromCode: BRL, toCode: USD, rate: 0.2, asOf: older }),
      rate({ fromCode: USDC, toCode: USD, rate: 1, asOf: newer }),
    ];
    const result = consolidateInCurrency(
      [amount(BRL, 100), amount(USDC, 100)],
      USD,
      rates,
      NOW,
      OPTIONS.thresholds,
      2,
    );
    expect(result.asOf).toBe(older);
  });

  it('an empty amount list totals 0 with nothing excluded and no asOf', () => {
    const result = consolidateInCurrency([], USD, [], NOW, OPTIONS.thresholds, 2);
    expect(result).toEqual({ total: 0, stale: false, asOf: null, excluded: [] });
  });

  it('when every currency is excluded, asOf is null rather than a stale leftover', () => {
    const result = consolidateInCurrency([amount(BTC, 1)], USD, [], NOW, OPTIONS.thresholds, 2);
    expect(result).toEqual({ total: 0, stale: false, asOf: null, excluded: [{ currency: BTC, reason: 'no_rate' }] });
  });

  it('a zero amount with no rate on file is skipped entirely, not excluded — it contributes nothing either way', () => {
    const result = consolidateInCurrency([amount(BTC, 0), amount(USD, 100)], USD, [], NOW, OPTIONS.thresholds, 2);
    expect(result).toEqual({ total: 100, stale: false, asOf: NOW.toISOString(), excluded: [] });
  });

  it('a zero amount with a stale rate on file does not flip the total stale', () => {
    const staleAsOf = new Date(NOW.getTime() - 25 * 60 * 60 * 1000).toISOString();
    const rates = [rate({ fromCode: BTC, toCode: USD, rate: 60000, asOf: staleAsOf })];
    const result = consolidateInCurrency([amount(BTC, 0), amount(USD, 100)], USD, rates, NOW, OPTIONS.thresholds, 2);
    expect(result).toEqual({ total: 100, stale: false, asOf: NOW.toISOString(), excluded: [] });
  });
});

describe('toBulkItem / buildBulkResult', () => {
  const input = (from: CurrencyCode, to: CurrencyCode): SetExchangeRateInput => ({
    from,
    to,
    rate: 5,
    asOf: NOW.toISOString(),
  });

  const view = (from: CurrencyCode, to: CurrencyCode): CurrencyRateView => ({
    from,
    to,
    rate: 5,
    asOf: NOW.toISOString(),
  });

  it('toBulkItem maps an Ok result to a status: ok item', () => {
    expect(toBulkItem(input(USD, BRL), ok(view(USD, BRL)))).toEqual({ status: 'ok', rate: view(USD, BRL) });
  });

  it("toBulkItem maps an Err result to a status: error item carrying the input's pair", () => {
    expect(toBulkItem(input(USD, USD), err('boom'))).toEqual({ status: 'error', from: USD, to: USD, error: 'boom' });
  });

  it('buildBulkResult zips items with outcomes positionally', () => {
    const items = [input(USD, BRL), input(USD, USD)];
    const outcomes = [ok(view(USD, BRL)), err('same pair')];
    expect(buildBulkResult(items, outcomes)).toEqual([
      { status: 'ok', rate: view(USD, BRL) },
      { status: 'error', from: USD, to: USD, error: 'same pair' },
    ]);
  });
});
