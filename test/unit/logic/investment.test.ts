import { describe, expect, it } from 'vitest';
import {
  accountHoldings,
  cashToRestore,
  consolidatePortfolio,
  deriveInvestmentEventKey,
  eventView,
  foldPosition,
  foldPositions,
  holdingsTotalsByAccount,
  isOpening,
  mergeEventPatch,
  netWorthHoldings,
  openingResult,
  planOpening,
  valuePosition,
  valuePositions,
  withAccountHoldings,
  withNetWorthHoldings,
  type OpeningFacts,
  type ValuationContext,
} from '../../../src/logic/investment.js';
import { AccountType } from '../../../src/models/account.js';
import { AssetClass } from '../../../src/models/asset.js';
import {
  InvestmentEventType,
  PositionExclusionReason,
  investmentErrors,
  type InvestmentEventEntity,
} from '../../../src/models/investment.js';
import { CurrencyCode } from '../../../src/models/money.js';
import {
  cdbAsset,
  investmentAccount,
  kncrAsset,
  NOW,
  nuAsset,
  openingEvent,
  priceOf,
  rateOf,
  THRESHOLDS,
} from '../fixtures/investment.js';

const { USD, BRL, BTC } = CurrencyCode.enum;
const FRESH = '2026-11-18T12:00:00.000Z';
const hoursBeforeNow = (hours: number): string => new Date(NOW.getTime() - hours * 3_600_000).toISOString();
const DECIMALS = { USD: 2, BRL: 2, BTC: 8 } as const;

const context = (overrides: Partial<ValuationContext> = {}): ValuationContext => ({
  rates: [rateOf(USD, BRL, 5, FRESH), rateOf(BRL, USD, 0.2, FRESH)],
  baseCurrency: BRL,
  decimalsOf: (code) => DECIMALS[code as keyof typeof DECIMALS] ?? 2,
  now: NOW,
  ...THRESHOLDS,
  ...overrides,
});

describe('foldPosition / foldPositions — a position is derived, never stored', () => {
  it('an opening sets both quantity and average cost', () => {
    expect(foldPosition([openingEvent({ quantity: 10, unitCost: 8 })])).toEqual({ quantity: 10, avgCost: 8 });
  });

  it('no events is no position', () => {
    expect(foldPosition([])).toEqual({ quantity: 0, avgCost: 0 });
  });

  it('applies events in date order, whatever the order they are given in', () => {
    const early = openingEvent({ id: 'e1', date: '2026-01-01', quantity: 5, unitCost: 4 });
    const late = openingEvent({ id: 'e2', date: '2026-06-01', quantity: 7, unitCost: 6 });
    expect(foldPosition([late, early])).toEqual({ quantity: 7, avgCost: 6 });
  });

  it('leaves the position as it is for the event types reserved for a later step', () => {
    const opening = openingEvent();
    const reserved = [InvestmentEventType.enum.buy, InvestmentEventType.enum.sell, InvestmentEventType.enum.split].map(
      (type) => openingEvent({ id: type, type, date: '2026-11-10', quantity: 3, unitCost: 1 }),
    );
    expect(foldPosition([opening, ...reserved])).toEqual({ quantity: 10, avgCost: 8 });
  });

  it('folds each account × asset on its own', () => {
    const events = [
      openingEvent({ id: 'e1', accountId: 'acc-1', assetId: 'asset-nu', quantity: 10 }),
      openingEvent({ id: 'e2', accountId: 'acc-2', assetId: 'asset-nu', quantity: 20 }),
      openingEvent({ id: 'e3', accountId: 'acc-1', assetId: 'asset-kncr', quantity: 30 }),
    ];
    expect(foldPositions(events).map((p) => [p.accountId, p.assetId, p.quantity])).toEqual([
      ['acc-1', 'asset-nu', 10],
      ['acc-2', 'asset-nu', 20],
      ['acc-1', 'asset-kncr', 30],
    ]);
  });

  it('lists no events as no positions', () => {
    expect(foldPositions([])).toEqual([]);
  });

  it('recognizes an opening', () => {
    expect(isOpening(openingEvent())).toBe(true);
    expect(isOpening(openingEvent({ type: InvestmentEventType.enum.buy }))).toBe(false);
  });
});

describe('deriveInvestmentEventKey (ADR-029)', () => {
  const identity = {
    accountId: 'acc-inv',
    assetId: 'asset-nu',
    type: InvestmentEventType.enum.opening,
    date: '2026-11-01',
    quantity: 10,
    unitCost: 8,
  };

  it('is stable: the same identity derives the same key', () => {
    expect(deriveInvestmentEventKey(identity, 2)).toBe(deriveInvestmentEventKey({ ...identity }, 2));
    expect(deriveInvestmentEventKey(identity, 2)).toMatch(/^[0-9a-f]{64}$/);
  });

  it.each([
    ['account', { accountId: 'acc-other' }],
    ['asset', { assetId: 'asset-kncr' }],
    ['type', { type: InvestmentEventType.enum.buy }],
    ['date', { date: '2026-11-02' }],
    ['quantity', { quantity: 11 }],
    ['unit cost', { unitCost: 9 }],
  ])('differs when the %s differs', (_field, change) => {
    expect(deriveInvestmentEventKey({ ...identity, ...change }, 2)).not.toBe(deriveInvestmentEventKey(identity, 2));
  });

  it('rounds the unit cost to the asset currency’s decimals: 8.001 and 8 are one identity at 2 decimals only', () => {
    expect(deriveInvestmentEventKey({ ...identity, unitCost: 8.001 }, 2)).toBe(deriveInvestmentEventKey(identity, 2));
    expect(deriveInvestmentEventKey({ ...identity, unitCost: 8.001 }, 8)).not.toBe(
      deriveInvestmentEventKey(identity, 8),
    );
  });

  it('a discriminator separates two otherwise identical events, and cannot blur a field boundary', () => {
    expect(deriveInvestmentEventKey(identity, 2, 'second')).not.toBe(deriveInvestmentEventKey(identity, 2));
    expect(deriveInvestmentEventKey(identity, 2, 'a')).not.toBe(deriveInvestmentEventKey(identity, 2, 'b'));
    expect(deriveInvestmentEventKey({ ...identity, accountId: 'acc-inv', assetId: 'x' }, 2, 'y')).not.toBe(
      deriveInvestmentEventKey({ ...identity, accountId: 'acc-inv"', assetId: 'x' }, 2, 'y'),
    );
  });
});

describe('planOpening', () => {
  const facts = (overrides: Partial<OpeningFacts> = {}): OpeningFacts => ({
    id: 'event-new',
    today: '2026-11-18',
    input: { account: 'Nu Holdings (NYSE:NU)', asset: 'NU', quantity: 10, avgCost: 8 },
    account: investmentAccount(),
    asset: nuAsset(),
    price: undefined,
    hasOpening: false,
    decimals: 2,
    ...overrides,
  });

  it('plans an opening at the given average cost, dated today, with the account’s cash at 0', () => {
    const plan = planOpening(facts())._unsafeUnwrap();
    expect(plan.event).toEqual({
      id: 'event-new',
      accountId: 'acc-inv',
      assetId: 'asset-nu',
      type: 'opening',
      date: '2026-11-18',
      quantity: 10,
      unitCost: 8,
      note: null,
      replacedCash: null,
    });
    expect(plan.initialBalance).toBe(0);
    expect(plan.warnings).toEqual([]);
    expect(plan.idempotencyKey).toBe(deriveInvestmentEventKey(plan.event, 2));
  });

  it('remembers the account cash it replaces, so deleting the opening can give it back', () => {
    const plan = (cash: number, remainingCash?: number) =>
      planOpening(
        facts({
          account: investmentAccount({ initialBalance: cash }),
          input: { account: 'x', asset: 'NU', quantity: 1, avgCost: 1, remainingCash },
        }),
      )._unsafeUnwrap();
    expect(plan(500, 85).event.replacedCash).toBe(500);
    expect(plan(500).event.replacedCash).toBe(500);
    expect(plan(0, 85).event.replacedCash).toBe(0);
  });

  it('replaces nothing — and so restores nothing — when the cash is already what the caller leaves', () => {
    const plan = (cash: number, remainingCash?: number) =>
      planOpening(
        facts({
          account: investmentAccount({ initialBalance: cash }),
          input: { account: 'x', asset: 'NU', quantity: 1, avgCost: 1, remainingCash },
        }),
      )._unsafeUnwrap();
    expect(plan(85, 85).event.replacedCash).toBeNull();
    expect(plan(0).event.replacedCash).toBeNull();
  });

  it('does not let the replaced cash change the idempotency key', () => {
    const base = planOpening(facts())._unsafeUnwrap();
    const replacing = planOpening(facts({ account: investmentAccount({ initialBalance: 9 }) }))._unsafeUnwrap();
    expect(replacing.idempotencyKey).toBe(base.idempotencyKey);
  });

  it('carries the date, the note and the remaining cash the caller gave', () => {
    const plan = planOpening(
      facts({
        input: { account: 'x', asset: 'NU', quantity: 1, avgCost: 1, date: '2026-10-05', remainingCash: 85, note: 'n' },
      }),
    )._unsafeUnwrap();
    expect(plan.event).toMatchObject({ date: '2026-10-05', note: 'n' });
    expect(plan.initialBalance).toBe(85);
  });

  it('takes an explicit average cost of 0 as given (bonus shares), never as missing', () => {
    const plan = planOpening(
      facts({ input: { account: 'x', asset: 'NU', quantity: 1, avgCost: 0 }, price: priceOf(nuAsset(), 13, FRESH) }),
    )._unsafeUnwrap();
    expect(plan.event.unitCost).toBe(0);
    expect(plan.warnings).toEqual([]);
  });

  it('defaults the average cost to the latest price and warns that P&L starts there', () => {
    const plan = planOpening(
      facts({ input: { account: 'x', asset: 'NU', quantity: 10 }, price: priceOf(nuAsset(), 13.2, FRESH) }),
    )._unsafeUnwrap();
    expect(plan.event.unitCost).toBe(13.2);
    expect(plan.warnings).toHaveLength(1);
    expect(plan.warnings[0]).toContain('P&L for NYSE:NU starts at the latest price (13.2');
  });

  it('is refused with no average cost and no price: set a price or give avgCost', () => {
    const refusal = planOpening(facts({ input: { account: 'x', asset: 'NU', quantity: 10 } }))._unsafeUnwrapErr();
    expect(refusal).toEqual(investmentErrors.noPriceNoCost('NYSE:NU'));
    expect(refusal).toMatchObject({
      code: 'validation',
      issues: [expect.stringContaining('set a price or give avgCost')],
    });
  });

  it('is refused on an account that is not an investment account', () => {
    expect(
      planOpening(facts({ account: investmentAccount({ type: AccountType.enum.checking }) }))._unsafeUnwrapErr(),
    ).toEqual(investmentErrors.notInvestmentAccount('Nu Holdings (NYSE:NU)', 'checking'));
  });

  it('is refused for a second opening of the same account and asset', () => {
    expect(planOpening(facts({ hasOpening: true }))._unsafeUnwrapErr()).toEqual(
      investmentErrors.openingExists('Nu Holdings (NYSE:NU)', 'NYSE:NU'),
    );
  });

  it('builds the result with the cost basis rounded to the asset currency’s decimals', () => {
    const plan = planOpening(
      facts({ input: { account: 'x', asset: 'NU', quantity: 3, avgCost: 1.111 } }),
    )._unsafeUnwrap();
    expect(openingResult(plan, investmentAccount(), nuAsset(), 2)).toMatchObject({
      asset: 'NYSE:NU',
      account: 'Nu Holdings (NYSE:NU)',
      type: 'opening',
      avgCost: 1.111,
      costBasis: 3.33,
      warnings: [],
    });
  });
});

describe('cashToRestore — what deleting an event gives back (ADR-038 §7)', () => {
  it('is the cash an opening replaced', () => {
    expect(cashToRestore(openingEvent({ replacedCash: 500 }))).toBe(500);
    expect(cashToRestore(openingEvent({ replacedCash: 0 }))).toBe(0);
  });

  it('is nothing for an opening that replaced nothing', () => {
    expect(cashToRestore(openingEvent({ replacedCash: null }))).toBeNull();
  });

  it('is nothing for an event that is not an opening, whatever it holds', () => {
    expect(cashToRestore(openingEvent({ type: InvestmentEventType.enum.buy, replacedCash: 500 }))).toBeNull();
  });
});

describe('events: views and patches', () => {
  const entity: InvestmentEventEntity = { ...openingEvent(), version: 2 };

  it('shows an event with its account name and asset label', () => {
    expect(eventView(openingEvent(), investmentAccount(), nuAsset())).toEqual({
      id: 'event-1',
      account: 'Nu Holdings (NYSE:NU)',
      asset: 'NYSE:NU',
      type: 'opening',
      date: '2026-11-01',
      quantity: 10,
      avgCost: 8,
      note: null,
      replacedCash: null,
    });
  });

  it('lays the patch over the event, keeping what it omits and the version', () => {
    expect(mergeEventPatch(entity, { id: 'event-1', quantity: 12, avgCost: 0 })).toEqual({
      ...entity,
      quantity: 12,
      unitCost: 0,
    });
  });

  it('sets, keeps and clears the note', () => {
    expect(mergeEventPatch(entity, { id: 'e', note: 'hi' }).note).toBe('hi');
    expect(mergeEventPatch({ ...entity, note: 'hi' }, { id: 'e' }).note).toBe('hi');
    expect(mergeEventPatch({ ...entity, note: 'hi' }, { id: 'e', note: null }).note).toBeNull();
  });
});

describe('valuePosition — read-time valuation (ADR-038 §4)', () => {
  const account = investmentAccount();
  const position = { accountId: 'acc-inv', assetId: 'asset-nu', quantity: 10, avgCost: 8 };
  const nu = nuAsset();

  it('values quantity × price in the asset currency and converts it to the base currency', () => {
    const valuation = valuePosition({ position, account, asset: nu, price: priceOf(nu, 13, FRESH) }, context());
    expect(valuation).toMatchObject({
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
    const valuation = valuePosition(
      {
        position: { ...position, assetId: kncr.id, quantity: 100, avgCost: 9 },
        account,
        asset: kncr,
        price: priceOf(kncr, 10, FRESH),
      },
      context({ rates: [] }),
    );
    expect(valuation).toMatchObject({
      marketValue: 1000,
      noRate: false,
      stale: false,
      base: { rate: 1, costBasis: 900, marketValue: 1000, unrealized: 100 },
    });
  });

  it('flags a stale market price (older than the hours window) but still values it', () => {
    const valuation = valuePosition(
      { position, account, asset: nu, price: priceOf(nu, 13, hoursBeforeNow(100)) },
      context({ rates: [rateOf(USD, BRL, 5, hoursBeforeNow(1))] }),
    );
    expect(valuation).toMatchObject({ stale: true, marketValue: 130, asOf: hoursBeforeNow(100) });
  });

  it('keeps a manual price of the same age fresh: its window is in days', () => {
    const cdb = cdbAsset();
    const valuation = valuePosition(
      {
        position: { ...position, assetId: cdb.id, quantity: 1, avgCost: 1000 },
        account,
        asset: cdb,
        price: priceOf(cdb, 1010, hoursBeforeNow(10 * 24)),
      },
      context(),
    );
    expect(valuation).toMatchObject({ stale: false, marketValue: 1010, unrealized: 10 });
  });

  it('flags a manual price past the days window as stale', () => {
    const cdb = cdbAsset();
    const valuation = valuePosition(
      {
        position: { ...position, assetId: cdb.id, quantity: 1, avgCost: 1000 },
        account,
        asset: cdb,
        price: priceOf(cdb, 1010, hoursBeforeNow(40 * 24)),
      },
      context(),
    );
    expect(valuation.stale).toBe(true);
  });

  it('flags the position stale when the rate is stale, even with a fresh price', () => {
    const valuation = valuePosition(
      { position, account, asset: nu, price: priceOf(nu, 13, FRESH) },
      context({ rates: [rateOf(USD, BRL, 5, hoursBeforeNow(48))] }),
    );
    expect(valuation).toMatchObject({ stale: true, asOf: hoursBeforeNow(48) });
  });

  it('with no price the market value is null — never 0 — but the cost is still known', () => {
    const valuation = valuePosition({ position, account, asset: nu, price: undefined }, context());
    expect(valuation).toMatchObject({
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
    const valuation = valuePosition(
      { position, account, asset: nu, price: priceOf(nu, 13, FRESH) },
      context({ rates: [] }),
    );
    expect(valuation).toMatchObject({ noRate: true, base: null, marketValue: 130, unrealized: 50, asOf: FRESH });
  });

  it('rounds to each currency’s own decimals', () => {
    const valuation = valuePosition(
      { position: { ...position, quantity: 3, avgCost: 1.111 }, account, asset: nu, price: priceOf(nu, 1.115, FRESH) },
      context(),
    );
    expect(valuation).toMatchObject({ costBasis: 3.33, marketValue: 3.35, unrealized: 0.02 });
  });
});

describe('valuePositions', () => {
  it('values each position against its account, asset and newest price, dropping one with an unknown asset', () => {
    const nu = nuAsset();
    const positions = [
      { accountId: 'acc-inv', assetId: 'asset-nu', quantity: 2, avgCost: 1 },
      { accountId: 'acc-inv', assetId: 'asset-gone', quantity: 2, avgCost: 1 },
    ];
    const prices = [priceOf(nu, 10, '2026-11-10T00:00:00.000Z', 'old'), priceOf(nu, 12, FRESH, 'new')];
    const valued = valuePositions(positions, [investmentAccount()], [nu], prices, context());
    expect(valued).toHaveLength(1);
    expect(valued[0]).toMatchObject({ asset: 'NYSE:NU', price: 12, marketValue: 24 });
  });
});

describe('consolidatePortfolio', () => {
  const account = investmentAccount();
  const nu = nuAsset();
  const kncr = kncrAsset();
  const cdb = cdbAsset();
  const value = (asset: typeof nu, quantity: number, avgCost: number, price: number | undefined, ctx = context()) =>
    valuePosition(
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
    const { totals } = consolidatePortfolio(valuations, BRL, 2);
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
    const stale = value(nu, 10, 8, 13, context({ rates: [rateOf(USD, BRL, 5, hoursBeforeNow(48))] }));
    expect(consolidatePortfolio([stale], BRL, 2).totals.stale).toBe(true);
    expect(consolidatePortfolio([value(cdb, 1, 1, undefined)], BRL, 2).totals).toMatchObject({
      stale: false,
      asOf: null,
      marketValue: 0,
    });
  });

  it('allocates by asset class and by currency, sorted by value, summing to 100 within rounding', () => {
    const valuations = [value(nu, 10, 8, 13), value(kncr, 100, 9, 10), value(cdb, 1, 1000, 1100)];
    const { allocation } = consolidatePortfolio(valuations, BRL, 2);
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
    const { allocation, totals } = consolidatePortfolio([value(cdb, 1, 1, undefined)], BRL, 2);
    expect(allocation).toEqual({ byAssetClass: [], byCurrency: [] });
    expect(totals.excluded).toHaveLength(1);
  });
});

describe('holdings in balances and net worth (ADR-038 §6)', () => {
  const account = investmentAccount();
  const nu = nuAsset();
  const valuation = valuePosition(
    {
      position: { accountId: 'acc-inv', assetId: nu.id, quantity: 10, avgCost: 8 },
      account,
      asset: nu,
      price: priceOf(nu, 13, FRESH),
    },
    context(),
  );
  const unpriced = valuePosition(
    {
      position: { accountId: 'acc-other', assetId: nu.id, quantity: 1, avgCost: 8 },
      account: investmentAccount({ id: 'acc-other', name: 'Other' }),
      asset: nu,
      price: undefined,
    },
    context(),
  );

  it('totals each account’s positions on their own', () => {
    const totals = holdingsTotalsByAccount([valuation, unpriced], BRL, 2);
    expect(totals['acc-inv']).toMatchObject({ marketValue: 650 });
    expect(totals['acc-other']).toMatchObject({ marketValue: 0, excluded: [{ reason: 'no_price' }] });
  });

  it('adds holdings only to an account that holds positions, leaving the others exactly as they were', () => {
    const plain = { id: 'acc-plain', balance: 10 };
    const invested = { id: 'acc-inv', balance: 100, converted: { value: 500 } };
    const [first, second] = withAccountHoldings([plain, invested], [valuation], BRL, 2);
    expect(first).toBe(plain);
    expect(second?.holdings).toEqual({
      cashBalance: 100,
      holdingsValue: 650,
      baseCurrency: BRL,
      total: 1150,
      stale: false,
      asOf: FRESH,
      excluded: [],
    });
  });

  it('has no total when the cash cannot be converted, but still reports the holdings', () => {
    const [entry] = withAccountHoldings([{ id: 'acc-inv', balance: 100 }], [valuation], BRL, 2);
    expect(entry?.holdings).toMatchObject({ total: null, holdingsValue: 650 });
    expect(accountHoldings(5, undefined, holdingsTotalsByAccount([valuation], BRL, 2)['acc-inv']!, 2).total).toBeNull();
  });

  it('adds the holdings to the net worth total and itemizes them; with none it is the same object', () => {
    const netWorth = { baseCurrency: BRL, total: 500, excluded: ['acc-x'] };
    const holdings = netWorthHoldings([valuation, unpriced], BRL, 2);
    expect(holdings).toMatchObject({ value: 650, stale: false, excluded: [{ asset: 'NYSE:NU', reason: 'no_price' }] });
    expect(withNetWorthHoldings(netWorth, holdings, 2)).toEqual({ ...netWorth, total: 1150, holdings });
    expect(netWorthHoldings([], BRL, 2)).toBeUndefined();
    expect(withNetWorthHoldings(netWorth, undefined, 2)).toBe(netWorth);
  });
});
