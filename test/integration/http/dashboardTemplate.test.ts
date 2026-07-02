import { describe, expect, it } from 'vitest';
import { setupHttpTest } from './setup.js';

const { inject } = setupHttpTest();

// The endpoints the baseline template (src/diplomat/db/seed/dashboards.ts) fetches on load.
// Kept in sync manually with that file's `Api` object — this test's job is to catch drift
// against the *live* OpenAPI contract, not to duplicate the template's own source of truth.
const FETCHED_API_PATHS = [
  '/api/summary',
  '/api/aggregate',
  '/api/accounts/balances',
  '/api/recurring',
  '/api/transactions',
];

// Patterns that would indicate the shell embeds a frozen data snapshot instead of fetching it —
// this is the enforcement of ADR-013's non-negotiable: "dashboards never contain data — they fetch it."
const INLINE_DATA_BLOB_PATTERN =
  /(?:const|let|var)\s+\w*(spending|transactions|balances|accounts|recurring)\w*\s*=\s*[[{]/i;
const ALLOWED_EXTERNAL_HOST_PREFIX = 'https://cdn.jsdelivr.net/npm/chart.js';

describe('baseline dashboard template is data-less (ADR-013 Phase B)', () => {
  it('serves a template that fetches every section from same-origin /api, embedding no data', async () => {
    const res = await inject({ method: 'GET', url: '/ui/overview' });
    expect(res.statusCode).toBe(200);
    const html = res.body;

    expect(html).toContain('fetch(');
    for (const path of FETCHED_API_PATHS) {
      expect(html, `expected the template to fetch ${path}`).toContain(path);
    }

    expect(html).not.toMatch(INLINE_DATA_BLOB_PATTERN);

    const externalUrls = html.match(/https?:\/\/[^"'\s)]+/g) ?? [];
    for (const url of externalUrls) {
      expect(url.startsWith(ALLOWED_EXTERNAL_HOST_PREFIX), `unexpected external host: ${url}`).toBe(true);
    }
  });

  it('only fetches endpoints that exist in the live OpenAPI contract', async () => {
    const doc = (await inject({ method: 'GET', url: '/api/openapi.json' })).json();
    for (const path of FETCHED_API_PATHS) {
      expect(doc.paths[path], `${path} missing from GET /api/openapi.json`).toBeDefined();
    }
  });
});
