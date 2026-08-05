import { describe, expect, it } from 'vitest';
import { setupHttpTest } from './setup.js';

const { inject } = setupHttpTest();

// The endpoints the baseline template's fragment (ui/dashboards/overview.html) fetches on load.
// Kept in sync manually with that file's `Api` object — this test's job is to catch drift against
// the *live* OpenAPI contract, not to duplicate the template's own source of truth.
const FETCHED_API_PATHS = [
  '/api/summary',
  '/api/aggregate',
  '/api/accounts/balances',
  '/api/recurring',
  '/api/transactions',
];

// Patterns that would indicate the fragment embeds a frozen data snapshot instead of fetching it —
// this is the enforcement of ADR-013's non-negotiable: "dashboards never contain data — they fetch it."
const INLINE_DATA_BLOB_PATTERN =
  /(?:const|let|var)\s+\w*(spending|transactions|balances|accounts|recurring)\w*\s*=\s*[[{]/i;
// The `@` pins this to the official chart.js package itself — a bare `chart.js` prefix would also
// accept a typosquat like `chart.js-malicious@...` served from the same trusted CDN host.
const ALLOWED_EXTERNAL_HOST_PREFIX = 'https://cdn.jsdelivr.net/npm/chart.js@';

const externalUrlsIn = (html: string): string[] =>
  // Matches both absolute (https://host/...) and protocol-relative (//host/...) URLs — a
  // protocol-relative reference would still load an external host and must be caught too.
  (html.match(/(?:https?:)?\/\/[^"'\s)]+/g) ?? []).map((url) => (url.startsWith('//') ? 'https:' + url : url));

describe('baseline dashboard fragment is data-less (ADR-013 Phase B, converted to a fragment by ADR-027)', () => {
  it('serves a fragment that fetches every section from same-origin /api, embedding no data', async () => {
    const res = await inject({ method: 'GET', url: '/api/dashboards/overview' });
    expect(res.statusCode).toBe(200);
    const { html } = res.json() as { html: string };

    expect(html).toContain('fetch(');
    for (const path of FETCHED_API_PATHS) {
      expect(html, `expected the fragment to fetch ${path}`).toContain(path);
    }

    expect(html).not.toMatch(INLINE_DATA_BLOB_PATTERN);

    // The fragment itself references no external host at all now — Chart.js is loaded once by the
    // shell (GET /ui) instead of per-dashboard — but any reference a fragment does carry must still
    // be the one allowed CDN host, as defense in depth.
    for (const url of externalUrlsIn(html)) {
      expect(url.startsWith(ALLOWED_EXTERNAL_HOST_PREFIX), `unexpected external host: ${url}`).toBe(true);
    }

    // It's also not a full page — the shell (ui/shell.html) owns the document root now.
    expect(html).not.toMatch(/<!doctype html|<html[\s>]/i);
  });

  it('registers the live-update hook (ADR-027 Phase 3) as the last thing its script does', async () => {
    const res = await inject({ method: 'GET', url: '/api/dashboards/overview' });
    const { html } = res.json() as { html: string };

    expect(html).toContain('window.fintrackOnDataChanged');
    // Registered after the initial load call, not before — a stray SSE message arriving mid-init
    // must never call a handler whose sections haven't rendered yet.
    expect(html.indexOf('loadAll();')).toBeLessThan(html.indexOf('window.fintrackOnDataChanged ='));
  });

  it('only fetches endpoints that exist as GET operations in the live OpenAPI contract', async () => {
    const res = await inject({ method: 'GET', url: '/api/openapi.json' });
    expect(res.statusCode).toBe(200);
    const doc = res.json();
    for (const path of FETCHED_API_PATHS) {
      // The fragment only ever fetches with GET — checking the path key alone would pass even if
      // that path were documented for a different method only (e.g. POST-only).
      expect(doc.paths[path]?.get, `GET ${path} missing from /api/openapi.json`).toBeDefined();
    }
  });
});

describe('app shell loads Chart.js once, from the pinned allowed host (ADR-027)', () => {
  it('GET /ui references only the pinned chart.js CDN host externally', async () => {
    const res = await inject({ method: 'GET', url: '/ui' });
    expect(res.statusCode).toBe(200);
    const html = res.body;

    const externalUrls = externalUrlsIn(html);
    expect(externalUrls.length).toBeGreaterThan(0);
    for (const url of externalUrls) {
      expect(url.startsWith(ALLOWED_EXTERNAL_HOST_PREFIX), `unexpected external host: ${url}`).toBe(true);
    }
  });
});
