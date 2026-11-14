import { describe, expect, it } from 'vitest';
import { isWorthAnnouncing, planRelayBatch, pruneCutoff, shouldLook } from '../../../src/logic/change-events.js';
import type { ChangeEventEntry } from '../../../src/models/change-events.js';

const event = (id: number, entities: readonly string[], userId: string | null = 'u1'): ChangeEventEntry => ({
  id,
  origin: 'other',
  event: { userId, entities },
});

describe('pruneCutoff', () => {
  it('is the instant `retentionMs` before now, as ISO text that sorts like time', () => {
    const now = new Date('2026-11-14T12:00:00.000Z');

    expect(pruneCutoff(now, 10 * 60 * 1000)).toBe('2026-11-14T11:50:00.000Z');
  });
});

describe('isWorthAnnouncing', () => {
  it('is false for an event that names no entity and true otherwise', () => {
    expect(isWorthAnnouncing({ userId: 'u1', entities: [] })).toBe(false);
    expect(isWorthAnnouncing({ userId: null, entities: ['account'] })).toBe(true);
  });
});

describe('shouldLook', () => {
  it('looks on the first reading and whenever the version moved, never when it did not', () => {
    expect(shouldLook(null, 4)).toBe(true);
    expect(shouldLook(4, 5)).toBe(true);
    expect(shouldLook(4, 4)).toBe(false);
  });
});

describe('planRelayBatch', () => {
  it('publishes the decoded events in order and moves the cursor to the last row', () => {
    const plan = planRelayBatch(3, [event(4, ['account']), event(5, ['bill', 'transaction'], null)]);

    expect(plan.events).toEqual([
      { userId: 'u1', entities: ['account'] },
      { userId: null, entities: ['bill', 'transaction'] },
    ]);
    expect(plan.skipped).toEqual([]);
    expect(plan.lastId).toBe(5);
  });

  it('reports a skipped row and still advances the cursor past it', () => {
    const plan = planRelayBatch(0, [{ id: 7, skipped: 'entities is not valid JSON' }, event(8, ['tag'])]);

    expect(plan.skipped).toEqual([{ id: 7, skipped: 'entities is not valid JSON' }]);
    expect(plan.events).toEqual([{ userId: 'u1', entities: ['tag'] }]);
    expect(plan.lastId).toBe(8);
  });

  it('advances past a skipped row even when it is the whole batch', () => {
    expect(planRelayBatch(2, [{ id: 9, skipped: 'bad' }]).lastId).toBe(9);
  });

  it('keeps the cursor and publishes nothing for an empty batch', () => {
    expect(planRelayBatch(12, [])).toEqual({ events: [], skipped: [], lastId: 12 });
  });

  it('does not publish an event that names no entity, but still advances past it', () => {
    const plan = planRelayBatch(0, [event(1, [])]);

    expect(plan.events).toEqual([]);
    expect(plan.lastId).toBe(1);
  });
});
