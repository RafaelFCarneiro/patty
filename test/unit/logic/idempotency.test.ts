import { describe, expect, it } from 'vitest';
import * as idempotency from '../../../src/logic/idempotency.js';

describe('idempotency.joinUnambiguously', () => {
  it('keeps two field lists apart that a plain separator join would run together', () => {
    const separators = ['|', ',', ':', ' ', '/'];
    separators.forEach((separator) => {
      const first = ['acc', `x${separator}y`];
      const second = [`acc${separator}x`, 'y'];
      expect(first.join(separator)).toBe(second.join(separator));
      expect(idempotency.joinUnambiguously(first)).not.toBe(idempotency.joinUnambiguously(second));
    });
  });

  it('tells a missing field from an empty one', () => {
    expect(idempotency.joinUnambiguously(['a', null])).not.toBe(idempotency.joinUnambiguously(['a', '']));
  });
});

describe('idempotency.deriveKey — a discriminator cannot blur a field boundary', () => {
  const identity = {
    accountId: 'acc',
    assetId: 'asset',
    type: InvestmentEventType.enum.opening,
    date: '2026-11-01',
    quantity: 1,
    unitCost: 1,
  };

  it.each(['|', ',', ':', ' ', '/', '","'])('with %j inside the discriminator or the ids', (separator) => {
    const viaDiscriminator = idempotency.deriveKey(identity, 2, `a${separator}b`);
    const viaIds = idempotency.deriveKey({ ...identity, assetId: `asset${separator}a` }, 2, 'b');
    expect(viaDiscriminator).not.toBe(viaIds);
  });
});
