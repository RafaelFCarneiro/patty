import { describe, expect, it } from 'vitest';
import { foldPosition, foldPositions, isOpening } from '../../../../src/logic/investment/positions.js';
import { InvestmentEventType } from '../../../../src/models/investment/core.js';
import { openingEvent } from '../../fixtures/investment.js';

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
