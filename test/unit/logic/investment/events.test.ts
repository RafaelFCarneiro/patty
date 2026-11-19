import { describe, expect, it } from 'vitest';
import {
  InvestmentEventType,
  investmentErrors,
  type InvestmentEventEntity,
} from '../../../../src/models/investment/core.js';
import { investmentAccount, nuAsset, openingEvent } from '../../fixtures/investment.js';
import * as investmentEvents from '../../../../src/logic/investment/events.js';

describe('investmentEvents.cashToRestore — what deleting an event gives back (ADR-038 §7)', () => {
  it('is the cash an opening replaced', () => {
    expect(investmentEvents.cashToRestore(openingEvent({ replacedCash: 500 }))).toBe(500);
    expect(investmentEvents.cashToRestore(openingEvent({ replacedCash: 0 }))).toBe(0);
  });

  it('is nothing for an opening that replaced nothing', () => {
    expect(investmentEvents.cashToRestore(openingEvent({ replacedCash: null }))).toBeNull();
  });

  it('is nothing for an event that is not an opening, whatever it holds', () => {
    expect(
      investmentEvents.cashToRestore(openingEvent({ type: InvestmentEventType.enum.buy, replacedCash: 500 })),
    ).toBeNull();
  });
});

describe('events: views and patches', () => {
  const entity: InvestmentEventEntity = { ...openingEvent(), version: 2 };

  it('shows an event with its account name and asset label', () => {
    expect(investmentEvents.view(openingEvent(), investmentAccount(), nuAsset())).toEqual({
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
    expect(investmentEvents.mergePatch(entity, { id: 'event-1', quantity: 12, avgCost: 0 })).toEqual({
      ...entity,
      quantity: 12,
      unitCost: 0,
    });
  });

  it('sets, keeps and clears the note', () => {
    expect(investmentEvents.mergePatch(entity, { id: 'e', note: 'hi' }).note).toBe('hi');
    expect(investmentEvents.mergePatch({ ...entity, note: 'hi' }, { id: 'e' }).note).toBe('hi');
    expect(investmentEvents.mergePatch({ ...entity, note: 'hi' }, { id: 'e', note: null }).note).toBeNull();
  });
});

describe('investmentEvents.mergePatch — each field is kept unless given', () => {
  const existing: InvestmentEventEntity = { ...openingEvent({ note: 'old' }), version: 3 };
  const merged = (patch: Omit<Parameters<typeof investmentEvents.mergePatch>[1], 'id'>) =>
    investmentEvents.mergePatch(existing, { id: existing.id, ...patch });

  it.each([
    ['quantity', { quantity: 12 }, { quantity: 12 }],
    ['avgCost', { avgCost: 9 }, { unitCost: 9 }],
    ['date', { date: '2026-12-01' }, { date: '2026-12-01' }],
    ['note', { note: 'new' }, { note: 'new' }],
  ])('%s given replaces only itself', (_field, patch, expected) => {
    expect(merged(patch)).toEqual({ ...existing, ...expected });
  });

  it('omitted fields keep their values, the version and the replaced cash', () => {
    expect(merged({})).toEqual(existing);
  });

  it('a given zero is a value, not an omission', () => {
    expect(merged({ avgCost: 0 }).unitCost).toBe(0);
  });

  it('a null note clears it; an omitted one keeps it', () => {
    expect(merged({ note: null }).note).toBeNull();
    expect(merged({}).note).toBe('old');
  });
});

describe('investmentEvents.refusalToDelete — an opening that replaced cash goes last', () => {
  const account = { name: 'Nu Holdings (NYSE:NU)' };
  const replacing = openingEvent({ id: 'a', replacedCash: 700 });
  const other = openingEvent({ id: 'b', assetId: 'asset-kncr', replacedCash: null });

  it('refuses while other events remain on the account, naming it', () => {
    expect(investmentEvents.refusalToDelete(replacing, [other], account)).toEqual(
      investmentErrors.otherPositionsRemain('Nu Holdings (NYSE:NU)'),
    );
  });

  it('allows the last event of the account', () => {
    expect(investmentEvents.refusalToDelete(replacing, [], account)).toBeNull();
  });

  it('allows an opening that replaced nothing, whatever else remains', () => {
    expect(investmentEvents.refusalToDelete(other, [replacing], account)).toBeNull();
  });

  it('says what to do, without naming any edge’s vocabulary', () => {
    const refusal = investmentErrors.otherPositionsRemain('Broker');
    expect(refusal).toMatchObject({ code: 'validation' });
    expect(JSON.stringify(refusal)).toContain("delete the account's other openings first");
    expect(JSON.stringify(refusal)).not.toMatch(/update_account|delete_investment_event/);
  });
});
