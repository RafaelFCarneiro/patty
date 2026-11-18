import { describe, expect, it } from 'vitest';
import { cashToRestore, openingResult } from '../../../../src/logic/investment/events.js';
import { deriveInvestmentEventKey } from '../../../../src/logic/investment/idempotency.js';
import { planOpening } from '../../../../src/logic/investment/opening.js';
import { AccountType } from '../../../../src/models/account.js';
import { investmentErrors, investmentWarnings, type OpeningFacts } from '../../../../src/models/investment/core.js';
import { FRESH, investmentAccount, nuAsset, priceOf } from '../../fixtures/investment.js';

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

describe('cashReplacedByOpening — what deleting the opening gives back', () => {
  const opened = (cash: number, remainingCash?: number) =>
    planOpening({
      id: 'event-new',
      today: '2026-11-18',
      input: { account: 'x', asset: 'NU', quantity: 1, avgCost: 1, remainingCash },
      account: investmentAccount({ initialBalance: cash }),
      asset: nuAsset(),
      price: undefined,
      hasOpening: false,
      decimals: 2,
    })._unsafeUnwrap().event;

  it('the same cash replaces nothing, so deleting the opening restores nothing', () => {
    expect(opened(85, 85).replacedCash).toBeNull();
    expect(cashToRestore(opened(85, 85))).toBeNull();
    expect(cashToRestore(opened(0))).toBeNull();
  });

  it('a different cash is replaced, so deleting the opening gives the old balance back', () => {
    expect(opened(500, 85).replacedCash).toBe(500);
    expect(cashToRestore(opened(500, 85))).toBe(500);
    expect(cashToRestore(opened(500))).toBe(500);
  });
});

describe('opening rules — the first one violated refuses, in order', () => {
  const facts = (overrides: Partial<OpeningFacts>): OpeningFacts => ({
    id: 'event-new',
    today: '2026-11-18',
    input: { account: 'x', asset: 'NU', quantity: 1, avgCost: 1 },
    account: investmentAccount(),
    asset: nuAsset(),
    price: undefined,
    hasOpening: false,
    decimals: 2,
    ...overrides,
  });

  it('an account that is not an investment account is refused before the opening is even looked at', () => {
    const refused = planOpening(
      facts({ account: investmentAccount({ type: AccountType.enum.savings }), hasOpening: true }),
    )._unsafeUnwrapErr();
    expect(refused).toEqual(investmentErrors.notInvestmentAccount('Nu Holdings (NYSE:NU)', 'savings'));
  });

  it('an existing opening is refused once the account is fine', () => {
    expect(planOpening(facts({ hasOpening: true }))._unsafeUnwrapErr()).toEqual(
      investmentErrors.openingExists('Nu Holdings (NYSE:NU)', 'NYSE:NU'),
    );
  });

  it('a rule violation wins over a missing cost', () => {
    const refused = planOpening(
      facts({ input: { account: 'x', asset: 'NU', quantity: 1 }, hasOpening: true }),
    )._unsafeUnwrapErr();
    expect(refused).toMatchObject({ code: 'validation', issues: [expect.stringContaining('already has an opening')] });
  });
});

describe('the unit cost — the given one, else the latest price, else refused', () => {
  const facts = (input: OpeningFacts['input'], price?: OpeningFacts['price']): OpeningFacts => ({
    id: 'event-new',
    today: '2026-11-18',
    input,
    account: investmentAccount(),
    asset: nuAsset(),
    price,
    hasOpening: false,
    decimals: 2,
  });
  const quote = priceOf(nuAsset(), 13.2, FRESH);

  it('uses the given cost, without a warning, even when a price exists', () => {
    const plan = planOpening(facts({ account: 'x', asset: 'NU', quantity: 1, avgCost: 9 }, quote))._unsafeUnwrap();
    expect(plan.event.unitCost).toBe(9);
    expect(plan.warnings).toEqual([]);
  });

  it('uses a given cost of 0 (bonus shares) as given', () => {
    const plan = planOpening(facts({ account: 'x', asset: 'NU', quantity: 1, avgCost: 0 }, quote))._unsafeUnwrap();
    expect(plan.event.unitCost).toBe(0);
  });

  it('falls back to the latest price and warns that P&L starts there', () => {
    const plan = planOpening(facts({ account: 'x', asset: 'NU', quantity: 1 }, quote))._unsafeUnwrap();
    expect(plan.event.unitCost).toBe(13.2);
    expect(plan.warnings).toEqual([investmentWarnings.costFromPrice('NYSE:NU', 13.2, FRESH)]);
  });

  it('is refused with neither', () => {
    expect(planOpening(facts({ account: 'x', asset: 'NU', quantity: 1 }))._unsafeUnwrapErr()).toEqual(
      investmentErrors.noPriceNoCost('NYSE:NU'),
    );
  });
});
