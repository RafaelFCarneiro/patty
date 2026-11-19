import { describe, expect, it } from 'vitest';
import { type InvestmentEventEntity } from '../../../../src/models/investment/core.js';
import { investmentAccount, nuAsset, openingEvent } from '../../fixtures/investment.js';
import * as investmentEvents from '../../../../src/logic/investment/events.js';

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
