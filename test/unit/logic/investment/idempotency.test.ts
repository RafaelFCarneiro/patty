import { describe, expect, it } from 'vitest';
import { InvestmentEventType } from '../../../../src/models/investment/core.js';
import * as idempotency from '../../../../src/logic/investment/idempotency.js';

describe('idempotency.deriveKey (ADR-029)', () => {
  const identity = {
    accountId: 'acc-inv',
    assetId: 'asset-nu',
    type: InvestmentEventType.enum.opening,
    date: '2026-11-01',
    quantity: 10,
    unitCost: 8,
  };

  it('is stable: the same identity derives the same key', () => {
    expect(idempotency.deriveKey(identity, 2)).toBe(idempotency.deriveKey({ ...identity }, 2));
    expect(idempotency.deriveKey(identity, 2)).toMatch(/^[0-9a-f]{64}$/);
  });

  it('keeps a known key byte-identical, so stored events still deduplicate', () => {
    expect(
      idempotency.deriveKey(
        {
          ...identity,
          accountId: 'acc-1',
          assetId: 'ast-1',
          type: InvestmentEventType.enum.buy,
          date: '2026-06-09',
          quantity: 3,
          unitCost: 10.125,
        },
        2,
      ),
    ).toBe('961718bd2c84daff4cca361db04bb84c515fe5a47feb69edeb4b6f95357133bb');
  });

  it.each([
    ['account', { accountId: 'acc-other' }],
    ['asset', { assetId: 'asset-kncr' }],
    ['type', { type: InvestmentEventType.enum.buy }],
    ['date', { date: '2026-11-02' }],
    ['quantity', { quantity: 11 }],
    ['unit cost', { unitCost: 9 }],
  ])('differs when the %s differs', (_field, change) => {
    expect(idempotency.deriveKey({ ...identity, ...change }, 2)).not.toBe(idempotency.deriveKey(identity, 2));
  });

  it('rounds the unit cost to the asset currency’s decimals: 8.001 and 8 are one identity at 2 decimals only', () => {
    expect(idempotency.deriveKey({ ...identity, unitCost: 8.001 }, 2)).toBe(idempotency.deriveKey(identity, 2));
    expect(idempotency.deriveKey({ ...identity, unitCost: 8.001 }, 8)).not.toBe(idempotency.deriveKey(identity, 8));
  });

  it('a discriminator separates two otherwise identical events, and cannot blur a field boundary', () => {
    expect(idempotency.deriveKey(identity, 2, 'second')).not.toBe(idempotency.deriveKey(identity, 2));
    expect(idempotency.deriveKey(identity, 2, 'a')).not.toBe(idempotency.deriveKey(identity, 2, 'b'));
    expect(idempotency.deriveKey({ ...identity, accountId: 'acc-inv', assetId: 'x' }, 2, 'y')).not.toBe(
      idempotency.deriveKey({ ...identity, accountId: 'acc-inv"', assetId: 'x' }, 2, 'y'),
    );
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
