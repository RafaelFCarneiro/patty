import { describe, expect, it } from 'vitest';
import { isWorthAnnouncing } from '../../../src/logic/change-events.js';

describe('isWorthAnnouncing', () => {
  it('is false for an event that names no entity and true for a user’s event that names one', () => {
    expect(isWorthAnnouncing({ userId: 'u1', entities: [] })).toBe(false);
    expect(isWorthAnnouncing({ userId: 'u1', entities: ['account'] })).toBe(true);
  });

  it('is false for instance bookkeeping (no user), which no stream can receive', () => {
    expect(isWorthAnnouncing({ userId: null, entities: ['account'] })).toBe(false);
    expect(isWorthAnnouncing({ userId: null, entities: [] })).toBe(false);
  });
});
