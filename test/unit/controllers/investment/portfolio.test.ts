import { describe, expect, it } from 'vitest';
import { getAccountBalances } from '../../../../src/controllers/account/account.js';
import { getPortfolio } from '../../../../src/controllers/investment/portfolio.js';
import { AccountType, type AccountEntity } from '../../../../src/models/account.js';
import type { AssetEntity, AssetPriceEntity } from '../../../../src/models/investment/asset.js';
import { CurrencyCode } from '../../../../src/models/money.js';
import type { InvestmentEventEntity } from '../../../../src/models/investment/core.js';
import { investmentDeps } from '../../fixtures/investment-deps.js';
import {
  cdbAsset,
  investmentAccount,
  kncrAsset,
  nuAsset,
  openingEvent,
  priceOf,
  rateOf,
} from '../../fixtures/investment.js';

const { USD, BRL } = CurrencyCode.enum;
const FRESH = '2026-11-18T12:00:00.000Z';

const account = (overrides: Partial<AccountEntity> = {}): AccountEntity => ({
  ...investmentAccount(),
  version: 0,
  ...overrides,
});
const asset = (a = nuAsset()): AssetEntity => ({ ...a, version: 0 });
const price = (...args: Parameters<typeof priceOf>): AssetPriceEntity => ({ ...priceOf(...args), version: 0 });
const event = (overrides: Partial<InvestmentEventEntity> = {}): InvestmentEventEntity => ({
  ...openingEvent(),
  version: 0,
  ...overrides,
});

const checking = account({
  id: 'acc-chk',
  name: 'Itaú',
  type: AccountType.enum.checking,
  currency: BRL,
  initialBalance: 1000,
});
const RATES = [{ ...rateOf(USD, BRL, 5, FRESH), version: 0 }];

describe('getPortfolio', () => {
  const world = {
    accounts: [account({ initialBalance: 100 })],
    assets: [asset(), asset(kncrAsset()), asset(cdbAsset())],
    events: [
      event(),
      event({ id: 'e2', assetId: 'asset-kncr', quantity: 100, unitCost: 9 }),
      event({ id: 'e3', assetId: 'asset-cdb', quantity: 1, unitCost: 1000 }),
    ],
    prices: [price(nuAsset(), 13, FRESH), price(kncrAsset(), 10, FRESH)],
    rates: RATES,
    baseCurrency: BRL,
  };

  it('values each position and totals the valued ones in the base currency, naming the one with no price', async () => {
    const portfolio = (await getPortfolio(investmentDeps(world), {}))._unsafeUnwrap();
    expect(portfolio.baseCurrency).toBe(BRL);
    expect(portfolio.positions.map((p) => [p.asset, p.marketValue, p.noPrice])).toEqual([
      ['NYSE:NU', 130, false],
      ['B3:KNCR11', 1000, false],
      ['ITAU:CDB-ITAU', null, true],
    ]);
    expect(portfolio.totals).toMatchObject({ marketValue: 1650, costBasis: 1300, unrealized: 350 });
    expect(portfolio.totals.excluded).toEqual([
      { account: 'Nu Holdings (NYSE:NU)', asset: 'ITAU:CDB-ITAU', reason: 'no_price' },
    ]);
    expect(portfolio.allocation.byCurrency.map((s) => s.key)).toEqual([BRL, USD]);
  });

  it('excludes a position whose asset has no exchange rate to the base, and says so', async () => {
    const portfolio = (await getPortfolio(investmentDeps({ ...world, rates: [] }), {}))._unsafeUnwrap();
    expect(portfolio.totals.excluded).toEqual([
      { account: 'Nu Holdings (NYSE:NU)', asset: 'NYSE:NU', reason: 'no_rate' },
      { account: 'Nu Holdings (NYSE:NU)', asset: 'ITAU:CDB-ITAU', reason: 'no_price' },
    ]);
    expect(portfolio.totals.marketValue).toBe(1000);
  });

  it('has no positions to show for an account without events, and never reads assets or prices', async () => {
    const reads = { assets: 0, prices: 0 };
    const deps = investmentDeps({ accounts: [account()], assets: [asset()] });
    const assetsList = deps.assets.list;
    const pricesLatest = deps.assetPrices.latest;
    deps.assets.list = async () => {
      reads.assets += 1;
      return assetsList();
    };
    deps.assetPrices.latest = async () => {
      reads.prices += 1;
      return pricesLatest();
    };
    const portfolio = (await getPortfolio(deps, {}))._unsafeUnwrap();
    expect(portfolio.positions).toEqual([]);
    expect(portfolio.totals).toMatchObject({ marketValue: 0, costBasis: 0, excluded: [] });
    expect(reads).toEqual({ assets: 0, prices: 0 });
  });

  it('reads assets and prices once when there are events', async () => {
    const reads = { assets: 0, prices: 0 };
    const deps = investmentDeps(world);
    const assetsList = deps.assets.list;
    const pricesLatest = deps.assetPrices.latest;
    deps.assets.list = async () => {
      reads.assets += 1;
      return assetsList();
    };
    deps.assetPrices.latest = async () => {
      reads.prices += 1;
      return pricesLatest();
    };
    await getPortfolio(deps, {});
    expect(reads).toEqual({ assets: 1, prices: 1 });
  });

  it('narrows to one account by name; an unknown account is refused', async () => {
    const two = investmentDeps({
      ...world,
      accounts: [account(), account({ id: 'acc-2', name: 'Other' })],
      events: [event(), event({ id: 'e9', accountId: 'acc-2', quantity: 3 })],
    });
    expect((await getPortfolio(two, { account: 'Other' }))._unsafeUnwrap().positions.map((p) => p.quantity)).toEqual([
      3,
    ]);
    expect((await getPortfolio(two, { account: 'Nope' }))._unsafeUnwrapErr()).toMatchObject({
      code: 'unknown_account',
    });
  });
});

describe('getAccountBalances — holdings in balances and net worth (Feature Design 023 §6)', () => {
  const invested = account({ initialBalance: 100 });
  const holdingsWorld = {
    accounts: [checking, invested],
    assets: [asset()],
    events: [event()],
    prices: [price(nuAsset(), 13, FRESH)],
    rates: RATES,
    baseCurrency: BRL,
  };

  it('answers exactly as before for accounts without positions: no holdings key anywhere', async () => {
    const deps = investmentDeps({ accounts: [checking, invested], rates: RATES, baseCurrency: BRL });
    const result = (await getAccountBalances(deps))._unsafeUnwrap();
    expect(result.balances.map((b) => b.balance)).toEqual([1000, 100]);
    expect(result.balances.every((b) => !('holdings' in b))).toBe(true);
    expect('holdings' in result.consolidatedNetWorth).toBe(false);
    expect(result.consolidatedNetWorth).toEqual({ baseCurrency: BRL, total: 1500, excluded: [] });
  });

  it('splits an investment account into cash and holdings, and adds the holdings to the net worth', async () => {
    const result = (await getAccountBalances(investmentDeps(holdingsWorld)))._unsafeUnwrap();
    const [itau, nu] = result.balances;
    expect(itau && 'holdings' in itau).toBe(false);
    expect(nu).toMatchObject({
      balance: 100,
      converted: { value: 500 },
      holdings: {
        cashBalance: 100,
        holdingsValue: 650,
        baseCurrency: BRL,
        total: 1150,
        stale: false,
        excluded: [],
      },
    });
    expect(result.consolidatedNetWorth).toEqual({
      baseCurrency: BRL,
      total: 2150,
      excluded: [],
      holdings: { value: 650, stale: false, asOf: FRESH, excluded: [] },
    });
  });

  it('names a position with no price or rate in the exclusions instead of counting it as zero', async () => {
    const result = (
      await getAccountBalances(
        investmentDeps({
          ...holdingsWorld,
          assets: [asset(), asset(cdbAsset())],
          events: [event(), event({ id: 'e2', assetId: 'asset-cdb', quantity: 1, unitCost: 1000 })],
        }),
      )
    )._unsafeUnwrap();
    expect(result.consolidatedNetWorth.total).toBe(2150);
    expect(result.consolidatedNetWorth.holdings?.excluded).toEqual([
      { account: 'Nu Holdings (NYSE:NU)', asset: 'ITAU:CDB-ITAU', reason: 'no_price' },
    ]);
    expect(result.balances[1]?.holdings?.excluded).toHaveLength(1);

    const noRate = (await getAccountBalances(investmentDeps({ ...holdingsWorld, rates: [] })))._unsafeUnwrap();
    expect(noRate.consolidatedNetWorth.holdings).toMatchObject({ value: 0, excluded: [{ reason: 'no_rate' }] });
    expect(noRate.balances[1]?.holdings).toMatchObject({ holdingsValue: 0, total: null });
  });

  it('flags the holdings stale when a price is older than its window', async () => {
    const result = (
      await getAccountBalances(
        investmentDeps({ ...holdingsWorld, prices: [price(nuAsset(), 13, '2026-11-10T12:00:00.000Z')] }),
      )
    )._unsafeUnwrap();
    expect(result.consolidatedNetWorth.holdings?.stale).toBe(true);
    expect(result.balances[1]?.holdings?.stale).toBe(true);
  });

  it('flags the account total stale when only the cash rate is stale: fresh price, old USD→BRL rate', async () => {
    const oldRate = '2026-11-10T12:00:00.000Z';
    const result = (
      await getAccountBalances(
        investmentDeps({ ...holdingsWorld, rates: [{ ...rateOf(USD, BRL, 5, oldRate), version: 0 }] }),
        { account: 'Nu Holdings (NYSE:NU)' },
      )
    )._unsafeUnwrap();
    expect(result.balances[0]?.holdings).toMatchObject({ stale: true, asOf: oldRate });
  });

  it('after the last attempt, holdings of an account that still moves are reported stale', async () => {
    const deps = investmentDeps(holdingsWorld);
    let version = 0;
    deps.accounts.findRawById = async (id) => {
      const stored = holdingsWorld.accounts.find((candidate) => candidate.id === id);
      version += 1;
      return stored ? { ...stored, version } : null;
    };

    const result = (await getAccountBalances(deps, { account: 'Nu Holdings (NYSE:NU)' }))._unsafeUnwrap();

    expect(result.balances[0]?.holdings).toMatchObject({ holdingsValue: 650, stale: true });
    expect(result.consolidatedNetWorth.holdings?.stale).toBe(true);
  });

  it('reads the accounts again up to three times while their version moves, then answers', async () => {
    const deps = investmentDeps(holdingsWorld);
    let reads = 0;
    deps.accounts.findRawById = async (id) => {
      reads += 1;
      const stored = holdingsWorld.accounts.find((candidate) => candidate.id === id);
      return stored ? { ...stored, version: reads } : null;
    };
    await getAccountBalances(deps, { account: 'Nu Holdings (NYSE:NU)' });
    expect(reads).toBe(6);
  });

  it('a version that holds still settles at once: fresh holdings stay fresh', async () => {
    const result = (await getAccountBalances(investmentDeps(holdingsWorld)))._unsafeUnwrap();
    expect(result.balances[1]?.holdings?.stale).toBe(false);
  });

  it('counts only the positions of the accounts the filter selects', async () => {
    const result = (await getAccountBalances(investmentDeps(holdingsWorld), { account: 'Itaú' }))._unsafeUnwrap();
    expect('holdings' in result.consolidatedNetWorth).toBe(false);
    expect(result.consolidatedNetWorth.total).toBe(1000);
  });
});
