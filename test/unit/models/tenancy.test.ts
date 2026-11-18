import { describe, expect, it } from 'vitest';
import { ASSET_ENTITY_TAG, ASSET_PRICE_ENTITY_TAG } from '../../../src/models/investment/asset.js';
import { CURRENCY_RATE_ENTITY_TAG } from '../../../src/models/currency-rate.js';
import { INVESTMENT_EVENT_ENTITY_TAG } from '../../../src/models/investment/core.js';
import { SHARED_ENTITY_TAGS } from '../../../src/models/tenancy.js';

describe('SHARED_ENTITY_TAGS — the entities every user hears about', () => {
  it('lists the reference data that moves everyone’s valuations: rates, assets and prices', () => {
    expect(SHARED_ENTITY_TAGS).toEqual(
      expect.arrayContaining([CURRENCY_RATE_ENTITY_TAG, ASSET_ENTITY_TAG, ASSET_PRICE_ENTITY_TAG]),
    );
  });

  it('does not list a user’s holdings: an investment event is heard by its owner alone', () => {
    expect(SHARED_ENTITY_TAGS).not.toContain(INVESTMENT_EVENT_ENTITY_TAG);
  });
});
