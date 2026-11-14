import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { UI_DASHBOARDS_ROOT } from '../../../src/diplomat/db/repos/dashboards.js';
import { ACCOUNT_ENTITY_TAG } from '../../../src/models/account.js';
import { BILL_ENTITY_TAG } from '../../../src/models/bill.js';
import { BUDGET_ENTITY_TAG } from '../../../src/models/budget.js';
import { CATEGORY_ENTITY_TAG } from '../../../src/models/category.js';
import { CREDIT_CARD_ENTITY_TAG } from '../../../src/models/credit-card.js';
import { CURRENCY_RATE_ENTITY_TAG } from '../../../src/models/currency-rate.js';
import { DASHBOARD_ENTITY_TAG } from '../../../src/models/dashboard.js';
import { USER_SETTINGS_ENTITY_TAG } from '../../../src/models/locale.js';
import { RECURRING_ENTITY_TAG } from '../../../src/models/recurring.js';
import { TAG_ENTITY_TAG } from '../../../src/models/tag.js';
import { TRANSACTION_ENTITY_TAG } from '../../../src/models/transaction.js';
import { DASHBOARD_ENTITY_TAGS } from './entity-tags.js';

/** Dashboards listen for entity tags as plain strings, so a renamed or missing tag silently stops refreshing them. */
const LISTENER =
  /(?:function handleAppDataChanged|window\.onAppDataChanged = function)[\s\S]*?\[([^\]]*)\]\.indexOf\(tag\)/;

const tagsOf = (dashboard: string): string[] | null => {
  const listed = readFileSync(`${UI_DASHBOARDS_ROOT}/${dashboard}.html`, 'utf8').match(LISTENER)?.[1];
  return listed === undefined ? null : listed.split(',').map((tag) => tag.trim().replace(/^'|'$/g, ''));
};

// dashboard → the entity tags its /api calls read (docs/ui.md § Live update).
const EXPECTED_TAGS = {
  accounts: [
    ACCOUNT_ENTITY_TAG, TRANSACTION_ENTITY_TAG, CATEGORY_ENTITY_TAG, TAG_ENTITY_TAG, CURRENCY_RATE_ENTITY_TAG,
    USER_SETTINGS_ENTITY_TAG,
  ],
  budget: [
    BUDGET_ENTITY_TAG, TRANSACTION_ENTITY_TAG, CATEGORY_ENTITY_TAG, RECURRING_ENTITY_TAG, USER_SETTINGS_ENTITY_TAG,
    ACCOUNT_ENTITY_TAG, CURRENCY_RATE_ENTITY_TAG,
  ],
  cards: [
    CREDIT_CARD_ENTITY_TAG, TRANSACTION_ENTITY_TAG, ACCOUNT_ENTITY_TAG, BILL_ENTITY_TAG, CATEGORY_ENTITY_TAG,
    TAG_ENTITY_TAG,
  ],
  categories: [CATEGORY_ENTITY_TAG],
  comparative: [TRANSACTION_ENTITY_TAG, CATEGORY_ENTITY_TAG],
  dashboards: [DASHBOARD_ENTITY_TAG],
  overview: [
    TRANSACTION_ENTITY_TAG, ACCOUNT_ENTITY_TAG, CATEGORY_ENTITY_TAG, RECURRING_ENTITY_TAG,
    CURRENCY_RATE_ENTITY_TAG, USER_SETTINGS_ENTITY_TAG, CREDIT_CARD_ENTITY_TAG, BILL_ENTITY_TAG,
  ],
  pending: [
    TRANSACTION_ENTITY_TAG, RECURRING_ENTITY_TAG, ACCOUNT_ENTITY_TAG, CATEGORY_ENTITY_TAG, CREDIT_CARD_ENTITY_TAG,
    TAG_ENTITY_TAG,
  ],
  projections: [TRANSACTION_ENTITY_TAG, RECURRING_ENTITY_TAG, ACCOUNT_ENTITY_TAG, CATEGORY_ENTITY_TAG],
  tags: [TAG_ENTITY_TAG],
} as const;

describe('bundled dashboards live-update listeners', () => {
  it.each(Object.entries(EXPECTED_TAGS))('%s listens for every tag its data comes from', (dashboard, expected) => {
    const tags = tagsOf(dashboard);
    expect(tags, `${dashboard}.html tag list could not be parsed`).not.toBeNull();
    expect(tags).toEqual(expect.arrayContaining([...expected]));
  });

  it('covers every bundled dashboard', () => {
    const bundled = readdirSync(UI_DASHBOARDS_ROOT).map((file) => file.replace(/\.html$/, ''));
    expect(Object.keys(EXPECTED_TAGS).sort()).toEqual(bundled.sort());
  });

  describe('the shell resync list (ALL_ENTITY_TAGS)', () => {
    const shell = readFileSync(`${UI_DASHBOARDS_ROOT}/../app.js`, 'utf8').match(/ALL_ENTITY_TAGS = \[([^\]]*)\]/)?.[1];
    const shellTags = (shell ?? '').split(',').map((tag) => tag.trim().replace(/^'|'$/g, '')).filter(Boolean);

    it('holds every tag any dashboard listens for', () => {
      const listened = Object.keys(EXPECTED_TAGS).flatMap((dashboard) => tagsOf(dashboard) ?? []);
      expect(shellTags).toEqual(expect.arrayContaining(listened));
    });

    it('holds only real entity tags', () => {
      expect(shellTags.length).toBeGreaterThan(0);
      expect(DASHBOARD_ENTITY_TAGS).toEqual(expect.arrayContaining(shellTags));
    });
  });
});
