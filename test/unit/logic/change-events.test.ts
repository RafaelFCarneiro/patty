import { describe, expect, it } from 'vitest';
import { isWorthAnnouncing } from '../../../src/logic/change-events.js';

describe('isWorthAnnouncing', () => {
  it('is false for an event that names no entity and true otherwise', () => {
    expect(isWorthAnnouncing({ userId: 'u1', entities: [] })).toBe(false);
    expect(isWorthAnnouncing({ userId: null, entities: ['account'] })).toBe(true);
  });
});
