import { describe, expect, it } from 'vitest';
import { CurrencyCode } from '../../../../src/models/money.js';
import { AssetClass } from '../../../../src/models/investment/asset.js';
import { PositionExclusionReason } from '../../../../src/models/investment/core.js';
import {
  cdbAsset,
  FRESH,
  hoursBeforeNow,
  investmentAccount,
  kncrAsset,
  nuAsset,
  priceOf,
  rateOf,
  valuationContext,
} from '../../fixtures/investment.js';
import * as valuation from '../../../../src/logic/investment/valuation.js';

const { USD, BRL, BTC } = CurrencyCode.enum;

describe('valuation.value — read-time valuation (Feature Design 023 §4)', () => {
  const account = investmentAccount();
  const position = { accountId: 'acc-inv', assetId: 'asset-nu', quantity: 10, avgCost: 8 };
  const nu = nuAsset();

  it('values quantity × price in the asset currency and converts it to the base currency', () => {
    const valued = valuation.value({ position, account, asset: nu, price: priceOf(nu, 13, FRESH) }, valuationContext());
    expect(valued).toMatchObject({
      asset: 'NYSE:NU',
      quantity: 10,
      avgCost: 8,
      costBasis: 80,
      price: 13,
      marketValue: 130,
      unrealized: 50,
      asOf: FRESH,
      stale: false,
      noPrice: false,
      noRate: false,
      base: { currency: BRL, rate: 5, rateAsOf: FRESH, costBasis: 400, marketValue: 650, unrealized: 250 },
    });
  });

  it('is the identity for an asset already in the base currency: rate 1, never stale', () => {
    const kncr = kncrAsset();
    const valued = valuation.value(
      {
        position: { ...position, assetId: kncr.id, quantity: 100, avgCost: 9 },
        account,
        asset: kncr,
        price: priceOf(kncr, 10, FRESH),
      },
      valuationContext({ rates: [] }),
    );
    expect(valued).toMatchObject({
      marketValue: 1000,
      noRate: false,
      stale: false,
      base: { rate: 1, costBasis: 900, marketValue: 1000, unrealized: 100 },
    });
  });

  it('flags a stale market price (older than the hours window) but still values it', () => {
    const valued = valuation.value(
      { position, account, asset: nu, price: priceOf(nu, 13, hoursBeforeNow(100)) },
      valuationContext({ rates: [rateOf(USD, BRL, 5, hoursBeforeNow(1))] }),
    );
    expect(valued).toMatchObject({ stale: true, marketValue: 130, asOf: hoursBeforeNow(100) });
  });

  it('keeps a manual price of the same age fresh: its window is in days', () => {
    const cdb = cdbAsset();
    const valued = valuation.value(
      {
        position: { ...position, assetId: cdb.id, quantity: 1, avgCost: 1000 },
        account,
        asset: cdb,
        price: priceOf(cdb, 1010, hoursBeforeNow(10 * 24)),
      },
      valuationContext(),
    );
    expect(valued).toMatchObject({ stale: false, marketValue: 1010, unrealized: 10 });
  });

  it('flags a manual price past the days window as stale', () => {
    const cdb = cdbAsset();
    const valued = valuation.value(
      {
        position: { ...position, assetId: cdb.id, quantity: 1, avgCost: 1000 },
        account,
        asset: cdb,
        price: priceOf(cdb, 1010, hoursBeforeNow(40 * 24)),
      },
      valuationContext(),
    );
    expect(valued.stale).toBe(true);
  });

  it('flags the position stale when the rate is stale, even with a fresh price', () => {
    const valued = valuation.value(
      { position, account, asset: nu, price: priceOf(nu, 13, FRESH) },
      valuationContext({ rates: [rateOf(USD, BRL, 5, hoursBeforeNow(48))] }),
    );
    expect(valued).toMatchObject({ stale: true, asOf: hoursBeforeNow(48) });
  });

  it('with no price the market value is null — never 0 — but the cost is still known', () => {
    const valued = valuation.value({ position, account, asset: nu, price: undefined }, valuationContext());
    expect(valued).toMatchObject({
      noPrice: true,
      price: null,
      priceAsOf: null,
      marketValue: null,
      unrealized: null,
      costBasis: 80,
      stale: false,
      base: { costBasis: 400, marketValue: null, unrealized: null },
    });
  });

  it('with no exchange rate the base figures are null and the position says noRate', () => {
    const valued = valuation.value(
      { position, account, asset: nu, price: priceOf(nu, 13, FRESH) },
      valuationContext({ rates: [] }),
    );
    expect(valued).toMatchObject({ noRate: true, base: null, marketValue: 130, unrealized: 50, asOf: FRESH });
  });

  it('rounds to each currency’s own decimals', () => {
    const valued = valuation.value(
      { position: { ...position, quantity: 3, avgCost: 1.111 }, account, asset: nu, price: priceOf(nu, 1.115, FRESH) },
      valuationContext(),
    );
    expect(valued).toMatchObject({ costBasis: 3.33, marketValue: 3.35, unrealized: 0.02 });
  });
});

describe('valuation.valueAll', () => {
  it('values each position against its account, asset and newest price, dropping one with an unknown asset', () => {
    const nu = nuAsset();
    const positions = [
      { accountId: 'acc-inv', assetId: 'asset-nu', quantity: 2, avgCost: 1 },
      { accountId: 'acc-inv', assetId: 'asset-gone', quantity: 2, avgCost: 1 },
    ];
    const prices = [priceOf(nu, 10, '2026-11-10T00:00:00.000Z', 'old'), priceOf(nu, 12, FRESH, 'new')];
    const valued = valuation.valueAll(positions, [investmentAccount()], [nu], prices, valuationContext());
    expect(valued).toHaveLength(1);
    expect(valued[0]).toMatchObject({ asset: 'NYSE:NU', price: 12, marketValue: 24 });
  });
});

describe('valuation.consolidate', () => {
  const account = investmentAccount();
  const nu = nuAsset();
  const kncr = kncrAsset();
  const cdb = cdbAsset();
  const value = (
    asset: typeof nu,
    quantity: number,
    avgCost: number,
    price: number | undefined,
    ctx = valuationContext(),
  ) =>
    valuation.value(
      {
        position: { accountId: 'acc-inv', assetId: asset.id, quantity, avgCost },
        account,
        asset,
        price: price === undefined ? undefined : priceOf(asset, price, FRESH),
      },
      ctx,
    );

  it('totals the valued positions in the base currency and names those left out, never counting them as zero', () => {
    const valuations = [
      value(nu, 10, 8, 13),
      value(kncr, 100, 9, 10),
      value(cdb, 1, 1000, undefined),
      value(nuAsset({ id: 'asset-btc', symbol: 'FOO', currency: BTC }), 1, 1, 5),
    ];
    const { totals } = valuation.consolidate(valuations, BRL, 2);
    expect(totals).toMatchObject({
      baseCurrency: BRL,
      marketValue: 1650,
      costBasis: 1300,
      unrealized: 350,
      stale: false,
      asOf: FRESH,
    });
    expect(totals.excluded).toEqual([
      { account: 'Nu Holdings (NYSE:NU)', asset: 'ITAU:CDB-ITAU', reason: PositionExclusionReason.enum.no_price },
      { account: 'Nu Holdings (NYSE:NU)', asset: 'NYSE:FOO', reason: PositionExclusionReason.enum.no_rate },
    ]);
  });

  it('is stale when any valued part is, and an excluded position does not make it stale', () => {
    const stale = value(nu, 10, 8, 13, valuationContext({ rates: [rateOf(USD, BRL, 5, hoursBeforeNow(48))] }));
    expect(valuation.consolidate([stale], BRL, 2).totals.stale).toBe(true);
    expect(valuation.consolidate([value(cdb, 1, 1, undefined)], BRL, 2).totals).toMatchObject({
      stale: false,
      asOf: null,
      marketValue: 0,
    });
  });

  it('allocates by asset class and by currency, sorted by value, summing to 100 within rounding', () => {
    const valuations = [value(nu, 10, 8, 13), value(kncr, 100, 9, 10), value(cdb, 1, 1000, 1100)];
    const { allocation } = valuation.consolidate(valuations, BRL, 2);
    expect(allocation.byAssetClass.map((s) => [s.key, s.value])).toEqual([
      [AssetClass.enum.fixed_income, 1100],
      [AssetClass.enum.reit, 1000],
      [AssetClass.enum.stock, 650],
    ]);
    expect(allocation.byCurrency.map((s) => [s.key, s.value])).toEqual([
      [BRL, 2100],
      [USD, 650],
    ]);
    for (const slices of [allocation.byAssetClass, allocation.byCurrency]) {
      expect(Math.abs(slices.reduce((sum, slice) => sum + slice.pct, 0) - 100)).toBeLessThanOrEqual(0.02);
    }
    expect(allocation.byCurrency.map((s) => s.pct)).toEqual([76.36, 23.64]);
  });

  it('allocates nothing, and divides by nothing, when no position is valued', () => {
    const { allocation, totals } = valuation.consolidate([value(cdb, 1, 1, undefined)], BRL, 2);
    expect(allocation).toEqual({ byAssetClass: [], byCurrency: [] });
    expect(totals.excluded).toHaveLength(1);
  });
});

describe('a missing price or rate is null and excluded — never 0', () => {
  const account = investmentAccount();
  const nu = nuAsset();
  const position = { accountId: 'acc-inv', assetId: 'asset-nu', quantity: 10, avgCost: 8 };
  const unpriced = valuation.value({ position, account, asset: nu, price: undefined }, valuationContext());
  const unrated = valuation.value(
    { position, account, asset: nu, price: priceOf(nu, 13, FRESH) },
    valuationContext({ rates: [] }),
  );
  const priced = valuation.value({ position, account, asset: nu, price: priceOf(nu, 13, FRESH) }, valuationContext());

  it('a position without a price has value null, not 0, and is excluded from the total', () => {
    expect(unpriced.marketValue).toBeNull();
    expect(unpriced.unrealized).toBeNull();
    expect(unpriced.base?.marketValue).toBeNull();
    const { totals } = valuation.consolidate([priced, unpriced], BRL, 2);
    expect(totals.marketValue).toBe(650);
    expect(totals.excluded).toEqual([
      { account: account.name, asset: 'NYSE:NU', reason: PositionExclusionReason.enum.no_price },
    ]);
  });

  it('a position without an exchange rate has base value null, not 0, and is excluded from the total', () => {
    expect(unrated.base).toBeNull();
    expect(unrated.marketValue).toBe(130);
    const { totals } = valuation.consolidate([priced, unrated], BRL, 2);
    expect(totals.marketValue).toBe(650);
    expect(totals.excluded).toEqual([
      { account: account.name, asset: 'NYSE:NU', reason: PositionExclusionReason.enum.no_rate },
    ]);
  });

  it('a total of nothing valued is 0 only because nothing was valued, and says what was left out', () => {
    const { totals } = valuation.consolidate([unpriced, unrated], BRL, 2);
    expect(totals.marketValue).toBe(0);
    expect(totals.excluded).toHaveLength(2);
  });
});

describe('valuation.markStale — positions of unsettled accounts are never presented as settled', () => {
  const nu = nuAsset();
  const positionOn = (accountId: string) =>
    valuation.value(
      {
        position: { accountId, assetId: nu.id, quantity: 1, avgCost: 1 },
        account: investmentAccount({ id: accountId, name: accountId }),
        asset: nu,
        price: priceOf(nu, 2, FRESH),
      },
      valuationContext(),
    );

  it('flags the positions of the named accounts stale and leaves the others as they were', () => {
    const [moved, calm] = [positionOn('acc-moved'), positionOn('acc-calm')];
    const marked = valuation.markStale([moved, calm], ['acc-moved']);
    expect(marked[0]).toEqual({ ...moved, stale: true });
    expect(marked[1]).toBe(calm);
    expect(moved.stale).toBe(false);
  });

  it('changes nothing when no account is named', () => {
    const calm = positionOn('acc-calm');
    expect(valuation.markStale([calm], [])).toEqual([calm]);
  });
});
