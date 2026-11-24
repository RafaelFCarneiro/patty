import { err, ok } from 'neverthrow';
import { describe, expect, it } from 'vitest';
import { AssetClass, AssetPricing, type AssetPriceEntity } from '../../../../src/models/investment/asset.js';
import { CurrencyCode } from '../../../../src/models/money.js';
import { cdbAsset, kncrAsset, NOW, nuAsset, priceOf } from '../../fixtures/investment.js';
import * as assetRules from '../../../../src/logic/investment/asset.js';
import * as timestamp from '../../../../src/logic/timestamp.js';

const THRESHOLDS = { marketHours: 24, manualDays: 31 };
const HOUR_MS = 60 * 60 * 1000;
const hoursBeforeNow = (hours: number): string => new Date(NOW.getTime() - hours * HOUR_MS).toISOString();

describe('assetRules.parseRef / assetRules.label', () => {
  it('reads a bare symbol, upper-cased', () => {
    expect(assetRules.parseRef('nu')).toEqual({ symbol: 'NU', exchange: null });
  });

  it('reads EXCHANGE:SYMBOL', () => {
    expect(assetRules.parseRef('nyse:nu')).toEqual({ symbol: 'NU', exchange: 'NYSE' });
  });

  it('labels an asset the way a reference reads back', () => {
    expect(assetRules.label(nuAsset())).toBe('NYSE:NU');
    expect(assetRules.parseRef(assetRules.label(nuAsset()))).toEqual({ symbol: 'NU', exchange: 'NYSE' });
  });
});

describe('assetRules.resolve', () => {
  const assets = [nuAsset(), kncrAsset(), nuAsset({ id: 'asset-nu-b3', exchange: 'B3', name: 'Nu Holdings BDR' })];

  it('finds an asset by exact exchange and symbol', () => {
    expect(assetRules.resolve(assets, 'B3:NU')).toMatchObject({ kind: 'found', entity: { id: 'asset-nu-b3' } });
  });

  it('finds an asset by a symbol that is unique, whatever its case', () => {
    expect(assetRules.resolve(assets, 'kncr11')).toMatchObject({ kind: 'found', entity: { id: 'asset-kncr' } });
  });

  it('finds an asset by its exact name when no symbol matches', () => {
    expect(assetRules.resolve(assets, 'Kinea Rendimentos')).toMatchObject({
      kind: 'found',
      entity: { id: 'asset-kncr' },
    });
  });

  it('is ambiguous for a symbol quoted on two exchanges, listing the labelled candidates', () => {
    expect(assetRules.resolve(assets, 'NU')).toEqual({
      kind: 'ambiguous',
      query: 'NU',
      candidates: ['NYSE:NU', 'B3:NU'],
    });
  });

  it('is none for an unknown asset, listing every asset as a candidate', () => {
    expect(assetRules.resolve(assets, 'ZZZ')).toEqual({
      kind: 'none',
      query: 'ZZZ',
      candidates: ['NYSE:NU', 'B3:KNCR11', 'B3:NU'],
    });
  });
});

describe('assetRules.isPriceStale — each pricing class has its own window', () => {
  it('ages a market price by weekday hours: a Friday 20:00Z close is fresh to Monday 19:00Z, stale at 21:00Z', () => {
    const friday = '2026-11-13T20:00:00.000Z';
    const at = (now: string) => assetRules.isPriceStale(AssetPricing.enum.market, friday, new Date(now), THRESHOLDS);
    expect(at('2026-11-14T12:00:00.000Z')).toBe(false);
    expect(at('2026-11-15T12:00:00.000Z')).toBe(false);
    expect(at('2026-11-16T19:00:00.000Z')).toBe(false);
    expect(at('2026-11-16T21:00:00.000Z')).toBe(true);
  });

  it('a Wednesday market price is stale on Thursday evening', () => {
    const wednesday = '2026-11-18T12:00:00.000Z';
    const at = (now: string) => assetRules.isPriceStale(AssetPricing.enum.market, wednesday, new Date(now), THRESHOLDS);
    expect(at('2026-11-19T11:00:00.000Z')).toBe(false);
    expect(at('2026-11-19T19:00:00.000Z')).toBe(true);
  });

  it('a manual price keeps elapsed time: the weekend counts', () => {
    const friday = '2026-11-13T20:00:00.000Z';
    expect(
      assetRules.isPriceStale(AssetPricing.enum.manual, friday, new Date('2026-12-14T19:00:00.000Z'), THRESHOLDS),
    ).toBe(false);
    expect(
      assetRules.isPriceStale(AssetPricing.enum.manual, friday, new Date('2026-12-14T21:00:00.000Z'), THRESHOLDS),
    ).toBe(true);
  });

  it('ages a manual price in days: fresh at 30 days, stale at 32', () => {
    expect(assetRules.isPriceStale(AssetPricing.enum.manual, hoursBeforeNow(30 * 24), NOW, THRESHOLDS)).toBe(false);
    expect(assetRules.isPriceStale(AssetPricing.enum.manual, hoursBeforeNow(32 * 24), NOW, THRESHOLDS)).toBe(true);
  });

  it('does not treat a 10-day-old manual price as stale although a market price that old would be', () => {
    const asOf = hoursBeforeNow(10 * 24);
    expect(assetRules.isPriceStale(AssetPricing.enum.market, asOf, NOW, THRESHOLDS)).toBe(true);
    expect(assetRules.isPriceStale(AssetPricing.enum.manual, asOf, NOW, THRESHOLDS)).toBe(false);
  });
});

describe('assetRules.normalizeRegistration', () => {
  it('upper-cases the symbol and exchange and trims the name', () => {
    expect(
      assetRules.normalizeRegistration({
        symbol: ' nu ',
        exchange: 'nyse',
        name: '  Nu Holdings ',
        assetClass: AssetClass.enum.stock,
        currency: CurrencyCode.enum.USD,
        pricing: AssetPricing.enum.market,
      }),
    ).toMatchObject({ symbol: 'NU', exchange: 'NYSE', name: 'Nu Holdings' });
  });
});

describe('assetRules.planRegister — idempotent on symbol and exchange', () => {
  const { id: _id, ...request } = nuAsset();

  it('creates a new asset under the given id', () => {
    const plan = assetRules.planRegister('new-id', request, null);
    expect(plan).toEqual({ asset: { id: 'new-id', ...request }, created: true, renamed: false, warnings: [] });
    expect(assetRules.registerResult(plan)).toEqual({ asset: plan.asset, created: true });
  });

  it('returns an existing asset unchanged', () => {
    const plan = assetRules.planRegister('ignored', request, nuAsset());
    expect(plan).toEqual({ asset: nuAsset(), created: false, renamed: false, warnings: [] });
  });

  it('renames an existing asset when only the name differs', () => {
    const plan = assetRules.planRegister('ignored', { ...request, name: 'Nu Holdings Ltd' }, nuAsset());
    expect(plan.asset).toEqual(nuAsset({ name: 'Nu Holdings Ltd' }));
    expect(plan).toMatchObject({ created: false, renamed: true, warnings: [] });
  });

  it('keeps the registered class, currency and pricing and warns about each that was asked for differently', () => {
    const plan = assetRules.planRegister(
      'ignored',
      { ...request, assetClass: AssetClass.enum.etf, currency: CurrencyCode.enum.BRL },
      nuAsset(),
    );
    expect(plan.asset).toEqual(nuAsset());
    expect(plan.warnings).toHaveLength(2);
    expect(plan.warnings[0]).toContain('assetClass stays stock');
    expect(plan.warnings[1]).toContain('currency stays USD');
    expect(assetRules.registerResult(plan).warnings).toEqual(plan.warnings);
  });
});

describe('assetRules.planPrice', () => {
  const input = { asset: 'NU', price: 13.2, asOf: '2026-11-18T18:00:00-03:00', source: 'NYSE close' };

  it('adds a point to the history under a fresh id when none exists at that instant', () => {
    const plan = assetRules.planPrice('new-id', nuAsset(), input, null);
    expect(plan.price).toEqual({
      id: 'new-id',
      assetId: 'asset-nu',
      price: 13.2,
      asOf: '2026-11-18T21:00:00.000Z',
      source: 'NYSE close',
    });
    expect(plan.view).toEqual({
      asset: 'NYSE:NU',
      price: 13.2,
      asOf: '2026-11-18T21:00:00.000Z',
      source: 'NYSE close',
    });
  });

  it('revises the row already on file for that instant, keeping its id', () => {
    const existing: AssetPriceEntity = { ...priceOf(nuAsset(), 12, '2026-11-18T21:00:00.000Z', 'old-id'), version: 3 };
    expect(assetRules.planPrice('new-id', nuAsset(), { ...input, source: undefined }, existing).price).toMatchObject({
      id: 'old-id',
      price: 13.2,
      source: null,
    });
  });
});

describe('assetRules.latestPrice', () => {
  const nu = nuAsset();
  const prices = [
    priceOf(nu, 10, '2026-11-10T21:00:00.000Z', 'p1'),
    priceOf(nu, 12, '2026-11-17T21:00:00.000Z', 'p3'),
    priceOf(nu, 11, '2026-11-12T21:00:00.000Z', 'p2'),
    priceOf(kncrAsset(), 99, '2026-11-18T21:00:00.000Z', 'other'),
  ];

  it('is the newest by instant, whatever the order of the list', () => {
    expect(assetRules.latestPrice(prices, 'asset-nu')?.id).toBe('p3');
  });

  it('compares instants, not text: an offset can put a later-looking string earlier in time', () => {
    const offsets = [
      priceOf(nu, 1, '2026-11-18T23:00:00+05:00', 'earlier'),
      priceOf(nu, 2, '2026-11-18T20:00:00Z', 'later'),
    ];
    expect(assetRules.latestPrice(offsets, 'asset-nu')?.id).toBe('later');
  });

  it.each([
    ['the offset price first', ['2026-11-18T19:00:00-03', '2026-11-18T21:30:00.000Z']],
    ['the UTC price first', ['2026-11-18T21:30:00.000Z', '2026-11-18T19:00:00-03']],
  ])('reads an hour-only offset when picking the latest price: %s', (_order, instants) => {
    const [first, second] = instants as [string, string];
    const latest = assetRules.latestPrice(
      [priceOf(nu, 1, first, 'first'), priceOf(nu, 2, second, 'second')],
      'asset-nu',
    );
    expect(timestamp.parse(latest!.asOf).toISOString()).toBe('2026-11-18T22:00:00.000Z');
  });

  it('is undefined for an asset with no price', () => {
    expect(assetRules.latestPrice(prices, 'asset-none')).toBeUndefined();
  });
});

describe('assetRules.withLatestPrice / assetRules.matchesListFilter', () => {
  const nu = nuAsset();
  const cdb = cdbAsset();
  const prices = [priceOf(nu, 13, hoursBeforeNow(100)), priceOf(cdb, 1000, hoursBeforeNow(100))];
  const view = assetRules.withLatestPrice(prices, NOW, THRESHOLDS);

  it('flags a market price older than its window as stale, a manual one of the same age as fresh', () => {
    expect(view(nu)).toMatchObject({ price: 13, stale: true, noPrice: false });
    expect(view(cdb)).toMatchObject({ price: 1000, stale: false, noPrice: false });
  });

  it('says noPrice, with null price and as-of, for an asset never priced', () => {
    expect(view(kncrAsset())).toMatchObject({ price: null, priceAsOf: null, stale: false, noPrice: true });
  });

  it('filters by class, and staleOnly keeps what is stale or unpriced', () => {
    const views = [view(nu), view(cdb), view(kncrAsset())];
    expect(views.filter(assetRules.matchesListFilter({ staleOnly: true })).map((v) => v.symbol)).toEqual([
      'NU',
      'KNCR11',
    ]);
    expect(
      views.filter(assetRules.matchesListFilter({ assetClass: AssetClass.enum.fixed_income })).map((v) => v.symbol),
    ).toEqual(['CDB-ITAU']);
    expect(views.filter(assetRules.matchesListFilter({}))).toHaveLength(3);
  });
});

describe('bulk results', () => {
  const inputs = [
    { asset: 'NU', price: 1, asOf: '2026-11-18T21:00:00Z' },
    { asset: 'ZZZ', price: 1, asOf: '2026-11-18T21:00:00Z' },
  ];

  it('tags an item ok or error by its own outcome', () => {
    const view = { asset: 'NYSE:NU', price: 1, asOf: '2026-11-18T21:00:00.000Z' };
    expect(assetRules.toBulkItem(inputs[0]!, ok(view))).toEqual({ status: 'ok', price: view });
    expect(assetRules.toBulkItem(inputs[1]!, err('boom'))).toEqual({ status: 'error', asset: 'ZZZ', error: 'boom' });
  });

  it('pairs outcomes with their inputs in order', () => {
    const view = { asset: 'NYSE:NU', price: 1, asOf: '2026-11-18T21:00:00.000Z' };
    expect(assetRules.buildBulkResult(inputs, [ok(view), err('boom')]).map((item) => item.status)).toEqual([
      'ok',
      'error',
    ]);
  });
});
