import { describe, expect, it } from 'vitest';
import { deriveInvestmentEventKey, joinUnambiguously } from '../../../../src/logic/investment/idempotency.js';
import { InvestmentEventType } from '../../../../src/models/investment/core.js';

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

describe('joinUnambiguously', () => {
  it('keeps two field lists apart that a plain separator join would run together', () => {
    const separators = ['|', ',', ':', ' ', '/'];
    separators.forEach((separator) => {
      const first = ['acc', `x${separator}y`];
      const second = [`acc${separator}x`, 'y'];
      expect(first.join(separator)).toBe(second.join(separator));
      expect(joinUnambiguously(first)).not.toBe(joinUnambiguously(second));
    });
  });

  it('tells a missing field from an empty one', () => {
    expect(joinUnambiguously(['a', null])).not.toBe(joinUnambiguously(['a', '']));
  });
});

describe('deriveInvestmentEventKey — a discriminator cannot blur a field boundary', () => {
  const identity = {
    accountId: 'acc',
    assetId: 'asset',
    type: InvestmentEventType.enum.opening,
    date: '2026-11-01',
    quantity: 1,
    unitCost: 1,
  };

  it.each(['|', ',', ':', ' ', '/', '","'])('with %j inside the discriminator or the ids', (separator) => {
    const viaDiscriminator = deriveInvestmentEventKey(identity, 2, `a${separator}b`);
    const viaIds = deriveInvestmentEventKey({ ...identity, assetId: `asset${separator}a` }, 2, 'b');
    expect(viaDiscriminator).not.toBe(viaIds);
  });
});
