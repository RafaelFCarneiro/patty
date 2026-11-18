import { err, ok } from 'neverthrow';
import { describe, expect, it } from 'vitest';
import {
  assetLabel,
  buildBulkResult,
  canonicalTimestamp,
  isPriceStale,
  latestPrice,
  matchesListFilter,
  normalizeRegistration,
  parseAssetRef,
  planAssetPrice,
  planRegisterAsset,
  registerResult,
  resolveAsset,
  toBulkItem,
  withLatestPrice,
} from '../../../src/logic/asset.js';
import { AssetClass, AssetPricing, type AssetPriceEntity } from '../../../src/models/asset.js';
import { CurrencyCode } from '../../../src/models/money.js';
import { cdbAsset, kncrAsset, NOW, nuAsset, priceOf } from '../fixtures/investment.js';

const THRESHOLDS = { marketHours: 72, manualDays: 31 };
const HOUR_MS = 60 * 60 * 1000;
const hoursBeforeNow = (hours: number): string => new Date(NOW.getTime() - hours * HOUR_MS).toISOString();

describe('parseAssetRef / assetLabel', () => {
  it('reads a bare symbol, upper-cased', () => {
    expect(parseAssetRef('nu')).toEqual({ symbol: 'NU', exchange: null });
  });

  it('reads EXCHANGE:SYMBOL', () => {
    expect(parseAssetRef('nyse:nu')).toEqual({ symbol: 'NU', exchange: 'NYSE' });
  });

  it('labels an asset the way a reference reads back', () => {
    expect(assetLabel(nuAsset())).toBe('NYSE:NU');
    expect(parseAssetRef(assetLabel(nuAsset()))).toEqual({ symbol: 'NU', exchange: 'NYSE' });
  });
});

describe('resolveAsset', () => {
  const assets = [nuAsset(), kncrAsset(), nuAsset({ id: 'asset-nu-b3', exchange: 'B3', name: 'Nu Holdings BDR' })];

  it('finds an asset by exact exchange and symbol', () => {
    expect(resolveAsset(assets, 'B3:NU')).toMatchObject({ kind: 'found', entity: { id: 'asset-nu-b3' } });
  });

  it('finds an asset by a symbol that is unique, whatever its case', () => {
    expect(resolveAsset(assets, 'kncr11')).toMatchObject({ kind: 'found', entity: { id: 'asset-kncr' } });
  });

  it('finds an asset by its exact name when no symbol matches', () => {
    expect(resolveAsset(assets, 'Kinea Rendimentos')).toMatchObject({ kind: 'found', entity: { id: 'asset-kncr' } });
  });

  it('is ambiguous for a symbol quoted on two exchanges, listing the labelled candidates', () => {
    expect(resolveAsset(assets, 'NU')).toEqual({
      kind: 'ambiguous',
      query: 'NU',
      candidates: ['NYSE:NU', 'B3:NU'],
    });
  });

  it('is none for an unknown asset, listing every asset as a candidate', () => {
    expect(resolveAsset(assets, 'ZZZ')).toEqual({
      kind: 'none',
      query: 'ZZZ',
      candidates: ['NYSE:NU', 'B3:KNCR11', 'B3:NU'],
    });
  });
});

describe('isPriceStale — each pricing class has its own window', () => {
  it('ages a market price in hours: a Friday close is still fresh 71 hours later, stale at 73', () => {
    expect(isPriceStale(AssetPricing.enum.market, hoursBeforeNow(71), NOW, THRESHOLDS)).toBe(false);
    expect(isPriceStale(AssetPricing.enum.market, hoursBeforeNow(73), NOW, THRESHOLDS)).toBe(true);
  });

  it('ages a manual price in days: fresh at 30 days, stale at 32', () => {
    expect(isPriceStale(AssetPricing.enum.manual, hoursBeforeNow(30 * 24), NOW, THRESHOLDS)).toBe(false);
    expect(isPriceStale(AssetPricing.enum.manual, hoursBeforeNow(32 * 24), NOW, THRESHOLDS)).toBe(true);
  });

  it('does not treat a 10-day-old manual price as stale although a market price that old would be', () => {
    const asOf = hoursBeforeNow(10 * 24);
    expect(isPriceStale(AssetPricing.enum.market, asOf, NOW, THRESHOLDS)).toBe(true);
    expect(isPriceStale(AssetPricing.enum.manual, asOf, NOW, THRESHOLDS)).toBe(false);
  });
});

describe('normalizeRegistration', () => {
  it('upper-cases the symbol and exchange and trims the name', () => {
    expect(
      normalizeRegistration({
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

describe('planRegisterAsset — idempotent on symbol and exchange', () => {
  const { id: _id, ...request } = nuAsset();

  it('creates a new asset under the given id', () => {
    const plan = planRegisterAsset('new-id', request, null);
    expect(plan).toEqual({ asset: { id: 'new-id', ...request }, created: true, renamed: false, warnings: [] });
    expect(registerResult(plan)).toEqual({ asset: plan.asset, created: true });
  });

  it('returns an existing asset unchanged', () => {
    const plan = planRegisterAsset('ignored', request, nuAsset());
    expect(plan).toEqual({ asset: nuAsset(), created: false, renamed: false, warnings: [] });
  });

  it('renames an existing asset when only the name differs', () => {
    const plan = planRegisterAsset('ignored', { ...request, name: 'Nu Holdings Ltd' }, nuAsset());
    expect(plan.asset).toEqual(nuAsset({ name: 'Nu Holdings Ltd' }));
    expect(plan).toMatchObject({ created: false, renamed: true, warnings: [] });
  });

  it('keeps the registered class, currency and pricing and warns about each that was asked for differently', () => {
    const plan = planRegisterAsset(
      'ignored',
      { ...request, assetClass: AssetClass.enum.etf, currency: CurrencyCode.enum.BRL },
      nuAsset(),
    );
    expect(plan.asset).toEqual(nuAsset());
    expect(plan.warnings).toHaveLength(2);
    expect(plan.warnings[0]).toContain('assetClass stays stock');
    expect(plan.warnings[1]).toContain('currency stays USD');
    expect(registerResult(plan).warnings).toEqual(plan.warnings);
  });
});

describe('planAssetPrice / canonicalTimestamp', () => {
  const input = { asset: 'NU', price: 13.2, asOf: '2026-11-18T18:00:00-03:00', source: 'NYSE close' };

  it('stores the instant as canonical UTC', () => {
    expect(canonicalTimestamp('2026-11-18T18:00:00-03:00')).toBe('2026-11-18T21:00:00.000Z');
  });

  it('adds a point to the history under a fresh id when none exists at that instant', () => {
    const plan = planAssetPrice('new-id', nuAsset(), input, null);
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
    expect(planAssetPrice('new-id', nuAsset(), { ...input, source: undefined }, existing).price).toMatchObject({
      id: 'old-id',
      price: 13.2,
      source: null,
    });
  });
});

describe('latestPrice', () => {
  const nu = nuAsset();
  const prices = [
    priceOf(nu, 10, '2026-11-10T21:00:00.000Z', 'p1'),
    priceOf(nu, 12, '2026-11-17T21:00:00.000Z', 'p3'),
    priceOf(nu, 11, '2026-11-12T21:00:00.000Z', 'p2'),
    priceOf(kncrAsset(), 99, '2026-11-18T21:00:00.000Z', 'other'),
  ];

  it('is the newest by instant, whatever the order of the list', () => {
    expect(latestPrice(prices, 'asset-nu')?.id).toBe('p3');
  });

  it('compares instants, not text: an offset can put a later-looking string earlier in time', () => {
    const offsets = [
      priceOf(nu, 1, '2026-11-18T23:00:00+05:00', 'earlier'),
      priceOf(nu, 2, '2026-11-18T20:00:00Z', 'later'),
    ];
    expect(latestPrice(offsets, 'asset-nu')?.id).toBe('later');
  });

  it('is undefined for an asset with no price', () => {
    expect(latestPrice(prices, 'asset-none')).toBeUndefined();
  });
});

describe('withLatestPrice / matchesListFilter', () => {
  const nu = nuAsset();
  const cdb = cdbAsset();
  const prices = [priceOf(nu, 13, hoursBeforeNow(100)), priceOf(cdb, 1000, hoursBeforeNow(100))];
  const view = withLatestPrice(prices, NOW, THRESHOLDS);

  it('flags a market price older than its window as stale, a manual one of the same age as fresh', () => {
    expect(view(nu)).toMatchObject({ price: 13, stale: true, noPrice: false });
    expect(view(cdb)).toMatchObject({ price: 1000, stale: false, noPrice: false });
  });

  it('says noPrice, with null price and as-of, for an asset never priced', () => {
    expect(view(kncrAsset())).toMatchObject({ price: null, priceAsOf: null, stale: false, noPrice: true });
  });

  it('filters by class, and staleOnly keeps what is stale or unpriced', () => {
    const views = [view(nu), view(cdb), view(kncrAsset())];
    expect(views.filter(matchesListFilter({ staleOnly: true })).map((v) => v.symbol)).toEqual(['NU', 'KNCR11']);
    expect(views.filter(matchesListFilter({ assetClass: AssetClass.enum.fixed_income })).map((v) => v.symbol)).toEqual([
      'CDB-ITAU',
    ]);
    expect(views.filter(matchesListFilter({}))).toHaveLength(3);
  });
});

describe('bulk results', () => {
  const inputs = [
    { asset: 'NU', price: 1, asOf: '2026-11-18T21:00:00Z' },
    { asset: 'ZZZ', price: 1, asOf: '2026-11-18T21:00:00Z' },
  ];

  it('tags an item ok or error by its own outcome', () => {
    const view = { asset: 'NYSE:NU', price: 1, asOf: '2026-11-18T21:00:00.000Z' };
    expect(toBulkItem(inputs[0]!, ok(view))).toEqual({ status: 'ok', price: view });
    expect(toBulkItem(inputs[1]!, err('boom'))).toEqual({ status: 'error', asset: 'ZZZ', error: 'boom' });
  });

  it('pairs outcomes with their inputs in order', () => {
    const view = { asset: 'NYSE:NU', price: 1, asOf: '2026-11-18T21:00:00.000Z' };
    expect(buildBulkResult(inputs, [ok(view), err('boom')]).map((item) => item.status)).toEqual(['ok', 'error']);
  });
});
