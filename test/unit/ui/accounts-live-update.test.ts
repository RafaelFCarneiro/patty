import { describe, expect, it } from 'vitest';
import { ASSET_PRICE_ENTITY_TAG } from '../../../src/models/investment/asset.js';
import { INVESTMENT_EVENT_ENTITY_TAG } from '../../../src/models/investment/core.js';
import { TRANSACTION_ENTITY_TAG } from '../../../src/models/transaction.js';
import { loadFragment } from './fragment-sandbox.js';

// accounts.html reads /api/accounts/balances, where holdings are valued from prices and positions.
const refetchesOn = (tag: string): boolean => {
  const { sandbox } = loadFragment('accounts');
  let refetched = false;
  sandbox.fetchInitialData = () => {
    refetched = true;
  };
  sandbox.onAppDataChanged([tag]);
  return refetched;
};

describe('accounts.html onAppDataChanged', () => {
  it.each([ASSET_PRICE_ENTITY_TAG, INVESTMENT_EVENT_ENTITY_TAG, TRANSACTION_ENTITY_TAG])('refetches on %s', (tag) => {
    expect(refetchesOn(tag)).toBe(true);
  });

  it('ignores an entity it does not read', () => {
    expect(refetchesOn('budget')).toBe(false);
  });
});
