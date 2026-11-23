import { describe, expect, it } from 'vitest';
import { PersistOp } from '@rfc0/effect-runner';
import { listAssets, registerAsset, setAssetPrice } from '../../../../src/controllers/investment/assets.js';
import {
  ASSET_ENTITY_TAG,
  ASSET_PRICE_ENTITY_TAG,
  AssetClass,
  AssetPricing,
  RegisterAssetSchema,
  SetAssetPriceSchema,
  type AssetEntity,
  type AssetPriceEntity,
  type AssetPriceView,
} from '../../../../src/models/investment/asset.js';
import { CurrencyCode } from '../../../../src/models/money.js';
import { SetAssetPricesSchema } from '../../../../src/wire/in/assets.js';
import { decided, investmentDeps } from '../../fixtures/investment-deps.js';
import { cdbAsset, kncrAsset, NOW, nuAsset, priceOf } from '../../fixtures/investment.js';
import * as assetRules from '../../../../src/logic/investment/asset.js';

const entity = (asset = nuAsset(), version = 4): AssetEntity => ({ ...asset, version });
const priceEntity = (price: ReturnType<typeof priceOf>, version = 2): AssetPriceEntity => ({ ...price, version });
const { id: _id, ...NU_REQUEST } = nuAsset();

describe('registerAsset', () => {
  it('inserts a new asset under a fresh id, normalizing symbol and exchange', async () => {
    const deps = investmentDeps({ ids: ['asset-new'] });
    const { persist, response } = await decided(registerAsset(deps, { ...NU_REQUEST, symbol: 'nu', exchange: 'nyse' }));
    expect(persist).toEqual([
      { op: PersistOp.enum.insert, entity: ASSET_ENTITY_TAG, model: { id: 'asset-new', ...NU_REQUEST } },
    ]);
    expect(response).toEqual({ asset: { id: 'asset-new', ...NU_REQUEST }, created: true });
  });

  it('is idempotent: an asset already registered is returned unchanged, writing nothing', async () => {
    const deps = investmentDeps({ assets: [entity()] });
    const { persist, response } = await decided(registerAsset(deps, NU_REQUEST));
    expect(persist).toEqual([]);
    expect(response).toEqual({ asset: nuAsset(), created: false });
  });

  it('renames an existing asset with a version-guarded update that touches nothing else', async () => {
    const deps = investmentDeps({ assets: [entity()] });
    const { persist, response } = await decided(registerAsset(deps, { ...NU_REQUEST, name: 'Nu Holdings Ltd' }));
    expect(persist).toEqual([
      {
        op: PersistOp.enum.update,
        entity: ASSET_ENTITY_TAG,
        model: { ...nuAsset(), name: 'Nu Holdings Ltd', version: 4 },
      },
    ]);
    expect(response.created).toBe(false);
  });

  it('keeps the registered fields and warns when the request disagrees', async () => {
    const deps = investmentDeps({ assets: [entity()] });
    const { persist, response } = await decided(
      registerAsset(deps, { ...NU_REQUEST, assetClass: AssetClass.enum.etf, pricing: AssetPricing.enum.manual }),
    );
    expect(persist).toEqual([]);
    expect(response.asset).toEqual(nuAsset());
    expect(response.warnings).toHaveLength(2);
  });
});

describe('setAssetPrice', () => {
  const input = { asset: 'NU', price: 13.2, asOf: '2026-11-18T21:00:00Z', source: 'NYSE close' };

  it('refuses a price for an unknown asset, listing the known ones', async () => {
    const deps = investmentDeps({ assets: [entity()] });
    expect((await setAssetPrice(deps, { ...input, asset: 'ZZZ' }))._unsafeUnwrapErr()).toEqual({
      code: 'unknown_asset',
      query: 'ZZZ',
      candidates: ['NYSE:NU'],
    });
  });

  it('refuses a symbol quoted on two exchanges until the exchange is given', async () => {
    const deps = investmentDeps({ assets: [entity(), entity(nuAsset({ id: 'asset-nu-b3', exchange: 'B3' }))] });
    expect((await setAssetPrice(deps, input))._unsafeUnwrapErr()).toMatchObject({ code: 'ambiguous_asset' });
    expect((await decided(setAssetPrice(deps, { ...input, asset: 'B3:NU' }))).response.asset).toBe('B3:NU');
  });

  it.each(['2026-11-18T18:00:00-03', '2026-11-18T18:00:00-0300'])(
    'stores a compact offset (%s) as UTC instead of failing',
    async (asOf) => {
      const deps = investmentDeps({ assets: [entity()], ids: ['price-new'] });
      const { response } = await decided(setAssetPrice(deps, { ...input, asOf }));
      expect(response.asOf).toBe('2026-11-18T21:00:00.000Z');
    },
  );

  it('adds a point to the history with an insert at the canonical UTC instant', async () => {
    const deps = investmentDeps({ assets: [entity()], ids: ['price-new'] });
    const { persist, response } = await decided(setAssetPrice(deps, { ...input, asOf: '2026-11-18T18:00:00-03:00' }));
    expect(persist).toEqual([
      {
        op: PersistOp.enum.insert,
        entity: ASSET_PRICE_ENTITY_TAG,
        model: {
          id: 'price-new',
          assetId: 'asset-nu',
          price: 13.2,
          asOf: '2026-11-18T21:00:00.000Z',
          source: 'NYSE close',
        },
      },
    ]);
    expect(response).toEqual({ asset: 'NYSE:NU', price: 13.2, asOf: '2026-11-18T21:00:00.000Z', source: 'NYSE close' });
  });

  it('revises the price already on file for that instant, version-guarded, keeping its id', async () => {
    const existing = priceEntity(priceOf(nuAsset(), 12, '2026-11-18T21:00:00.000Z', 'price-old'), 7);
    const deps = investmentDeps({ assets: [entity()], prices: [existing] });
    const { persist } = await decided(setAssetPrice(deps, input));
    expect(persist).toEqual([
      {
        op: PersistOp.enum.update,
        entity: ASSET_PRICE_ENTITY_TAG,
        model: {
          id: 'price-old',
          assetId: 'asset-nu',
          price: 13.2,
          asOf: '2026-11-18T21:00:00.000Z',
          source: 'NYSE close',
          version: 7,
        },
      },
    ]);
  });

  it('a bulk call reports each item on its own: the bad one fails, the good one is applied', async () => {
    const deps = investmentDeps({ assets: [entity()], ids: ['p1'] });
    const items = [input, { ...input, asset: 'ZZZ' }];
    const outcomes = await Promise.all(
      items.map(async (item) => (await setAssetPrice(deps, item)).map((outcome) => outcome.response as AssetPriceView)),
    );
    const result = assetRules.buildBulkResult(items, outcomes);
    expect(result.map((item) => item.status)).toEqual(['ok', 'error']);
    expect(result[1]).toMatchObject({ asset: 'ZZZ', error: { code: 'unknown_asset' } });
  });

  it('values a manual asset from its posted price', async () => {
    const cdb = cdbAsset();
    const deps = investmentDeps({ assets: [entity(cdb)], ids: ['p-cdb'] });
    const posted = await decided(
      setAssetPrice(deps, { asset: 'CDB-ITAU', price: 1012.5, asOf: '2026-11-17T12:00:00Z' }),
    );
    const model = (posted.persist[0] as { model: { price: number; asOf: string; id: string; assetId: string } }).model;
    const listed = await listAssets(
      investmentDeps({ assets: [entity(cdb)], prices: [priceEntity({ ...model, source: null })] }),
      {},
    );
    expect(listed).toEqual([
      expect.objectContaining({ symbol: 'CDB-ITAU', price: 1012.5, stale: false, noPrice: false }),
    ]);
  });
});

describe('the boundary keeps an asset reference unambiguous', () => {
  it('refuses a colon in the exchange, since it separates exchange and symbol in a reference', () => {
    expect(RegisterAssetSchema.safeParse({ ...NU_REQUEST, exchange: 'NYSE:ARCA' }).success).toBe(false);
  });

  it('still accepts a colon in the symbol: the first colon alone splits a reference', () => {
    expect(RegisterAssetSchema.safeParse({ ...NU_REQUEST, symbol: 'ARCA:ABC' }).success).toBe(true);
  });
});

describe('the boundary refuses blank asset fields before anything is written', () => {
  it.each(['symbol', 'exchange', 'name'] as const)('a whitespace-only %s is refused', (field) => {
    expect(RegisterAssetSchema.safeParse({ ...NU_REQUEST, [field]: '   ' }).success).toBe(false);
    expect(RegisterAssetSchema.safeParse({ ...NU_REQUEST, [field]: '' }).success).toBe(false);
  });

  it('trims the padding of a filled field instead of storing it', () => {
    expect(RegisterAssetSchema.parse({ ...NU_REQUEST, name: '  Nu Holdings  ' }).name).toBe('Nu Holdings');
  });

  it('refuses a blank name on a rename too: a registration of a registered asset goes through the same schema', () => {
    expect(RegisterAssetSchema.safeParse({ ...NU_REQUEST, name: '\t ' }).success).toBe(false);
  });
});

describe('the boundary refuses a bad price before any flow runs', () => {
  it.each([0, -1])('a price of %s', (price) => {
    expect(SetAssetPriceSchema.safeParse({ asset: 'NU', price, asOf: '2026-11-18T21:00:00Z' }).success).toBe(false);
  });

  it('an instant without an offset', () => {
    expect(SetAssetPriceSchema.safeParse({ asset: 'NU', price: 1, asOf: '2026-11-18' }).success).toBe(false);
  });

  it('an empty bulk call and one over the cap', () => {
    const item = { asset: 'NU', price: 1, asOf: '2026-11-18T21:00:00Z' };
    expect(SetAssetPricesSchema.safeParse({ prices: [] }).success).toBe(false);
    expect(SetAssetPricesSchema.safeParse({ prices: Array.from({ length: 101 }, () => item) }).success).toBe(false);
    expect(SetAssetPricesSchema.safeParse({ prices: [item] }).success).toBe(true);
  });
});

describe('listAssets', () => {
  it('shows each asset with its newest price and flags, filtered by class and by need of a refresh', async () => {
    const oldPrice = new Date(NOW.getTime() - 100 * 3_600_000).toISOString();
    const deps = investmentDeps({
      assets: [entity(nuAsset()), entity(kncrAsset()), entity(cdbAsset())],
      prices: [priceEntity(priceOf(nuAsset(), 13, oldPrice)), priceEntity(priceOf(kncrAsset(), 10, NOW.toISOString()))],
    });
    const all = await listAssets(deps, {});
    expect(all.map((a) => [a.symbol, a.stale, a.noPrice])).toEqual([
      ['NU', true, false],
      ['KNCR11', false, false],
      ['CDB-ITAU', false, true],
    ]);
    expect((await listAssets(deps, { staleOnly: true })).map((a) => a.symbol)).toEqual(['NU', 'CDB-ITAU']);
    expect((await listAssets(deps, { assetClass: AssetClass.enum.reit })).map((a) => a.symbol)).toEqual(['KNCR11']);
  });

  it('the quote currency is part of what it lists', async () => {
    const listed = await listAssets(investmentDeps({ assets: [entity()] }), {});
    expect(listed[0]).toMatchObject({ currency: CurrencyCode.enum.USD, pricing: AssetPricing.enum.market });
  });
});
