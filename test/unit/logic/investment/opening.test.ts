import { describe, expect, it } from 'vitest';
import { AccountType } from '../../../../src/models/account.js';
import { investmentErrors, investmentWarnings, type OpeningFacts } from '../../../../src/models/investment/core.js';
import { FRESH, investmentAccount, nuAsset, openingEvent, priceOf } from '../../fixtures/investment.js';
import * as investmentEvents from '../../../../src/logic/investment/events.js';
import * as idempotency from '../../../../src/logic/investment/idempotency.js';
import * as opening from '../../../../src/logic/investment/opening.js';

describe('opening.plan', () => {
  const facts = (overrides: Partial<OpeningFacts> = {}): OpeningFacts => ({
    id: 'event-new',
    today: '2026-11-18',
    input: { account: 'Nu Holdings (NYSE:NU)', asset: 'NU', quantity: 10, avgCost: 8 },
    account: investmentAccount(),
    asset: nuAsset(),
    price: undefined,
    existingOpening: undefined,
    decimals: 2,
    ...overrides,
  });

  it('plans an opening at the given average cost, dated today, with the account’s cash at 0', () => {
    const plan = opening.plan(facts())._unsafeUnwrap();
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
    expect(plan.idempotencyKey).toBe(idempotency.deriveKey(plan.event, 2));
  });

  it('remembers the account cash it replaces, so deleting the opening can give it back', () => {
    const plan = (cash: number, remainingCash?: number) =>
      opening
        .plan(
          facts({
            account: investmentAccount({ initialBalance: cash }),
            input: { account: 'x', asset: 'NU', quantity: 1, avgCost: 1, remainingCash },
          }),
        )
        ._unsafeUnwrap();
    expect(plan(500, 85).event.replacedCash).toBe(500);
    expect(plan(500).event.replacedCash).toBe(500);
    expect(plan(0, 85).event.replacedCash).toBe(0);
  });

  it('replaces nothing — and so restores nothing — when the cash is already what the caller leaves', () => {
    const plan = (cash: number, remainingCash?: number) =>
      opening
        .plan(
          facts({
            account: investmentAccount({ initialBalance: cash }),
            input: { account: 'x', asset: 'NU', quantity: 1, avgCost: 1, remainingCash },
          }),
        )
        ._unsafeUnwrap();
    expect(plan(85, 85).event.replacedCash).toBeNull();
    expect(plan(0).event.replacedCash).toBeNull();
  });

  it('does not let the replaced cash change the idempotency key', () => {
    const base = opening.plan(facts())._unsafeUnwrap();
    const replacing = opening.plan(facts({ account: investmentAccount({ initialBalance: 9 }) }))._unsafeUnwrap();
    expect(replacing.idempotencyKey).toBe(base.idempotencyKey);
  });

  it('carries the date, the note and the remaining cash the caller gave', () => {
    const plan = opening
      .plan(
        facts({
          input: {
            account: 'x',
            asset: 'NU',
            quantity: 1,
            avgCost: 1,
            date: '2026-10-05',
            remainingCash: 85,
            note: 'n',
          },
        }),
      )
      ._unsafeUnwrap();
    expect(plan.event).toMatchObject({ date: '2026-10-05', note: 'n' });
    expect(plan.initialBalance).toBe(85);
  });

  it('takes an explicit average cost of 0 as given (bonus shares), never as missing', () => {
    const plan = opening
      .plan(
        facts({ input: { account: 'x', asset: 'NU', quantity: 1, avgCost: 0 }, price: priceOf(nuAsset(), 13, FRESH) }),
      )
      ._unsafeUnwrap();
    expect(plan.event.unitCost).toBe(0);
    expect(plan.warnings).toEqual([]);
  });

  it('defaults the average cost to the latest price and warns that P&L starts there', () => {
    const plan = opening
      .plan(facts({ input: { account: 'x', asset: 'NU', quantity: 10 }, price: priceOf(nuAsset(), 13.2, FRESH) }))
      ._unsafeUnwrap();
    expect(plan.event.unitCost).toBe(13.2);
    expect(plan.warnings).toHaveLength(1);
    expect(plan.warnings[0]).toContain('P&L for NYSE:NU starts at the latest price (13.2');
  });

  it('is refused with no average cost and no price: set a price or give avgCost', () => {
    const refusal = opening.plan(facts({ input: { account: 'x', asset: 'NU', quantity: 10 } }))._unsafeUnwrapErr();
    expect(refusal).toEqual(investmentErrors.noPriceNoCost('NYSE:NU'));
    expect(refusal).toMatchObject({
      code: 'validation',
      issues: [expect.stringContaining('set a price or give avgCost')],
    });
  });

  it('is refused on an account that is not an investment account', () => {
    expect(
      opening.plan(facts({ account: investmentAccount({ type: AccountType.enum.checking }) }))._unsafeUnwrapErr(),
    ).toEqual(investmentErrors.notInvestmentAccount('Nu Holdings (NYSE:NU)', 'checking'));
  });

  it('is refused for a second opening of the same account and asset', () => {
    expect(
      opening.plan(facts({ existingOpening: openingEvent({ id: 'old', quantity: 99 }) }))._unsafeUnwrapErr(),
    ).toEqual(investmentErrors.openingExists('Nu Holdings (NYSE:NU)', 'NYSE:NU'));
  });

  it('builds the result with the cost basis rounded to the asset currency’s decimals', () => {
    const plan = opening
      .plan(facts({ input: { account: 'x', asset: 'NU', quantity: 3, avgCost: 1.111 } }))
      ._unsafeUnwrap();
    expect(opening.result(plan, investmentAccount(), nuAsset(), 2)).toMatchObject({
      asset: 'NYSE:NU',
      account: 'Nu Holdings (NYSE:NU)',
      type: 'opening',
      avgCost: 1.111,
      costBasis: 3.33,
      warnings: [],
    });
  });
});

describe('opening.plan — the cash it replaces, which deleting the opening gives back', () => {
  const opened = (cash: number, remainingCash?: number) =>
    opening
      .plan({
        id: 'event-new',
        today: '2026-11-18',
        input: { account: 'x', asset: 'NU', quantity: 1, avgCost: 1, remainingCash },
        account: investmentAccount({ initialBalance: cash }),
        asset: nuAsset(),
        price: undefined,
        existingOpening: undefined,
        decimals: 2,
      })
      ._unsafeUnwrap().event;

  it('the same cash replaces nothing, so deleting the opening restores nothing', () => {
    expect(opened(85, 85).replacedCash).toBeNull();
    expect(investmentEvents.cashToRestore(opened(85, 85))).toBeNull();
    expect(investmentEvents.cashToRestore(opened(0))).toBeNull();
  });

  it('a different cash is replaced, so deleting the opening gives the old balance back', () => {
    expect(opened(500, 85).replacedCash).toBe(500);
    expect(investmentEvents.cashToRestore(opened(500, 85))).toBe(500);
    expect(investmentEvents.cashToRestore(opened(500))).toBe(500);
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
    existingOpening: undefined,
    decimals: 2,
    ...overrides,
  });

  it('an account that is not an investment account is refused before the opening is even looked at', () => {
    const refused = opening
      .plan(
        facts({
          account: investmentAccount({ type: AccountType.enum.savings }),
          existingOpening: openingEvent({ id: 'old', quantity: 99 }),
        }),
      )
      ._unsafeUnwrapErr();
    expect(refused).toEqual(investmentErrors.notInvestmentAccount('Nu Holdings (NYSE:NU)', 'savings'));
  });

  it('an existing opening is refused once the account is fine', () => {
    expect(
      opening.plan(facts({ existingOpening: openingEvent({ id: 'old', quantity: 99 }) }))._unsafeUnwrapErr(),
    ).toEqual(investmentErrors.openingExists('Nu Holdings (NYSE:NU)', 'NYSE:NU'));
  });

  it('a rule violation wins over a missing cost', () => {
    const refused = opening
      .plan(
        facts({
          input: { account: 'x', asset: 'NU', quantity: 1 },
          existingOpening: openingEvent({ id: 'old', quantity: 99 }),
        }),
      )
      ._unsafeUnwrapErr();
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
    existingOpening: undefined,
    decimals: 2,
  });
  const quote = priceOf(nuAsset(), 13.2, FRESH);

  it('uses the given cost, without a warning, even when a price exists', () => {
    const plan = opening.plan(facts({ account: 'x', asset: 'NU', quantity: 1, avgCost: 9 }, quote))._unsafeUnwrap();
    expect(plan.event.unitCost).toBe(9);
    expect(plan.warnings).toEqual([]);
  });

  it('uses a given cost of 0 (bonus shares) as given', () => {
    const plan = opening.plan(facts({ account: 'x', asset: 'NU', quantity: 1, avgCost: 0 }, quote))._unsafeUnwrap();
    expect(plan.event.unitCost).toBe(0);
  });

  it('falls back to the latest price and warns that P&L starts there', () => {
    const plan = opening.plan(facts({ account: 'x', asset: 'NU', quantity: 1 }, quote))._unsafeUnwrap();
    expect(plan.event.unitCost).toBe(13.2);
    expect(plan.warnings).toEqual([investmentWarnings.costFromPrice('NYSE:NU', 13.2, FRESH)]);
  });

  it('is refused with neither', () => {
    expect(opening.plan(facts({ account: 'x', asset: 'NU', quantity: 1 }))._unsafeUnwrapErr()).toEqual(
      investmentErrors.noPriceNoCost('NYSE:NU'),
    );
  });
});

describe('opening.resolveResponse — the response is built from what the write reported', () => {
  const planned = opening.result(
    opening
      .plan({
        id: 'minted',
        today: '2026-11-18',
        input: { account: 'x', asset: 'NU', quantity: 1, avgCost: 1 },
        account: investmentAccount(),
        asset: nuAsset(),
        price: undefined,
        existingOpening: undefined,
        decimals: 2,
      })
      ._unsafeUnwrap(),
    investmentAccount(),
    nuAsset(),
    2,
  );

  it('carries the stored event’s id and created true for a new opening', () => {
    expect(
      opening.resolveResponse(planned, { entity: 'investment_event', applied: true, read: 'minted' }),
    ).toMatchObject({
      id: 'minted',
      created: true,
    });
  });

  it('carries the surviving event’s id, not the minted one, and created false for a duplicate', () => {
    expect(
      opening.resolveResponse(planned, { entity: 'investment_event', applied: false, read: 'survivor' }),
    ).toMatchObject({ id: 'survivor', created: false });
  });

  it('refuses an outcome that names no event', () => {
    expect(() => opening.resolveResponse(planned, { entity: 'investment_event', applied: true })).toThrow();
  });
});

describe('opening.plan — the same opening recorded again is safe by design (ADR-029)', () => {
  const existing = openingEvent({ id: 'stored', date: '2026-11-01', quantity: 10, unitCost: 8, replacedCash: 500 });
  const again = (input: Partial<OpeningFacts['input']> = {}, overrides: Partial<OpeningFacts> = {}): OpeningFacts => ({
    id: 'minted',
    today: '2026-11-18',
    input: { account: 'x', asset: 'NU', quantity: 10, avgCost: 8, date: '2026-11-01', ...input },
    account: investmentAccount(),
    asset: nuAsset(),
    price: undefined,
    existingOpening: existing,
    decimals: 2,
    ...overrides,
  });

  it('plans the stored opening itself, not a new one, with its id in the response and created false', () => {
    const plan = opening.plan(again())._unsafeUnwrap();
    expect(plan.recordedBefore).toEqual(existing);
    const response = opening.result(plan, investmentAccount(), nuAsset(), 2);
    expect(response).toMatchObject({ id: 'stored', created: false, replacedCash: 500 });
  });

  it('answers wholly from the stored event: a repeat at 8.004 over a stored 8 reports avgCost 8, costBasis 80', () => {
    const plan = opening.plan(again({ avgCost: 8.004 }))._unsafeUnwrap();
    expect(plan.recordedBefore).toEqual(existing);
    expect(opening.result(plan, investmentAccount(), nuAsset(), 2)).toMatchObject({
      id: 'stored',
      avgCost: 8,
      quantity: 10,
      date: '2026-11-01',
      costBasis: 80,
      created: false,
    });
  });

  it('a first opening has nothing recorded before it and is created', () => {
    const plan = opening.plan(again({}, { existingOpening: undefined }))._unsafeUnwrap();
    expect(plan.recordedBefore).toBeNull();
    expect(opening.result(plan, investmentAccount(), nuAsset(), 2)).toMatchObject({ id: 'minted', created: true });
  });

  it('recognizes it when the cost comes from the latest price, if that is the stored cost', () => {
    const priced = again({ avgCost: undefined }, { price: priceOf(nuAsset(), 8, FRESH) });
    expect(opening.plan(priced)._unsafeUnwrap().recordedBefore).toEqual(existing);
  });

  it.each([
    ['quantity', { quantity: 11 }],
    ['cost', { avgCost: 9 }],
    ['date', { date: '2026-11-02' }],
  ])('a different %s is another opening, refused while one exists', (_field, change) => {
    expect(opening.plan(again(change))._unsafeUnwrapErr()).toEqual(
      investmentErrors.openingExists('Nu Holdings (NYSE:NU)', 'NYSE:NU'),
    );
  });

  it('with no cost and no price it cannot be the same opening, so it is refused as a second one', () => {
    expect(opening.plan(again({ avgCost: undefined }))._unsafeUnwrapErr()).toEqual(
      investmentErrors.openingExists('Nu Holdings (NYSE:NU)', 'NYSE:NU'),
    );
  });
});
