import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { UI_DASHBOARDS_ROOT } from '../../../src/diplomat/db/repos/dashboards.js';
import { USER_SETTINGS_ENTITY_TAG } from '../../../src/models/locale.js';
import { CURRENCY_RATE_ENTITY_TAG } from '../../../src/models/currencyRate.js';

/**
 * A dashboard refetches when `fintrackOnDataChanged` hears one of the entity tags it depends on (ADR-027 Phase 3). The
 * tags are plain strings in the HTML, so a renamed entity tag silently stops refreshing it — this pins the overview's
 * net-worth badge, which depends on the user's base currency and the exchange rates, to the real tag constants.
 */
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
