import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { UI_DASHBOARDS_ROOT } from '../../../src/diplomat/db/repos/dashboards.js';
import { USER_SETTINGS_ENTITY_TAG } from '../../../src/models/locale.js';
import { CURRENCY_RATE_ENTITY_TAG } from '../../../src/models/currencyRate.js';

/** Dashboards listen for entity tags as plain strings, so a renamed tag silently stops refreshing them. */
describe('overview.html live-update listener', () => {
  const listener = readFileSync(`${UI_DASHBOARDS_ROOT}/overview.html`, 'utf8').match(
    /function handleFintrackDataChanged[\s\S]*?\[([^\]]*)\]\.indexOf\(tag\)/,
  );
  const tags = (listener?.[1] ?? '').split(',').map((tag) => tag.trim().replace(/^'|'$/g, ''));

  it('refreshes when the user’s preferences change (base currency drives the net-worth badge)', () => {
    expect(listener).not.toBeNull();
    expect(tags).toContain(USER_SETTINGS_ENTITY_TAG);
  });

  it('refreshes when an exchange rate changes', () => {
    expect(tags).toContain(CURRENCY_RATE_ENTITY_TAG);
  });
});
