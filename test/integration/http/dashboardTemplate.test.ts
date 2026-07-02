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
// The `@` pins this to the official chart.js package itself — a bare `chart.js` prefix would also
// accept a typosquat like `chart.js-malicious@...` served from the same trusted CDN host.
const ALLOWED_EXTERNAL_HOST_PREFIX = 'https://cdn.jsdelivr.net/npm/chart.js@';

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

    // Matches both absolute (https://host/...) and protocol-relative (//host/...) URLs — a
    // protocol-relative reference would still load an external host and must be caught too.
    const externalUrls = html.match(/(?:https?:)?\/\/[^"'\s)]+/g) ?? [];
    for (const url of externalUrls) {
      const absoluteUrl = url.startsWith('//') ? 'https:' + url : url;
      expect(absoluteUrl.startsWith(ALLOWED_EXTERNAL_HOST_PREFIX), `unexpected external host: ${url}`).toBe(true);
    }
  });

  it('only fetches endpoints that exist as GET operations in the live OpenAPI contract', async () => {
    const res = await inject({ method: 'GET', url: '/api/openapi.json' });
    expect(res.statusCode).toBe(200);
    const doc = res.json();
    for (const path of FETCHED_API_PATHS) {
      // The template only ever fetches with GET — checking the path key alone would pass even if
      // that path were documented for a different method only (e.g. POST-only).
      expect(doc.paths[path]?.get, `GET ${path} missing from /api/openapi.json`).toBeDefined();
    }
  });
});
