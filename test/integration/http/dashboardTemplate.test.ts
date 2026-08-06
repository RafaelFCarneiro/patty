import { describe, expect, it } from 'vitest';
import { DashboardSource, type DashboardListItem } from '../../../src/models/dashboard.js';
import { setupHttpTest } from './setup.js';

const { inject } = setupHttpTest();

// The nine default dashboards, each a file-backed fragment under ui/dashboards/ (ADR-027 Phase 2).
// Kept as a literal list (not read off disk) so an added/removed default fails the drift check below
// instead of silently expanding or shrinking what this suite covers.
const DEFAULT_DASHBOARD_NAMES = [
  'overview',
  'accounts',
  'cards',
  'categories',
  'comparative',
  'dashboards',
  'pending',
  'projections',
  'tags',
] as const;

// Patterns that would indicate a fragment embeds a frozen data snapshot instead of fetching it — this
// is the enforcement of ADR-013's non-negotiable: "dashboards never contain data — they fetch it."
// Empty-literal (`[]`/`{}`) and spread (`[...x]`) initializations are excluded: those hold no data of
// their own — they're state placeholders / runtime copies, not embedded snapshots.
const INLINE_DATA_BLOB_PATTERN =
  /(?:const|let|var)\s+\w*(spending|transactions|balances|accounts|recurring)\w*\s*=\s*(?:\[(?!\s*\]|\s*\.\.\.)|\{(?!\s*\}))/i;

// Pinned CDN prefixes the app shell (ui/shell.html) and every fragment are allowed to reference
// externally — anything else means a new, unreviewed third-party host slipped in. Chart.js,
// Flatpickr, and Font Awesome each pin an exact version (#165) — the prefix here includes the
// version, so bumping or unpinning one without updating this list fails the test. Google Fonts'
// CSS2 API has no comparable fixed, versionable URL (its response varies by requesting
// User-Agent — see ui/shell.html's comment on that include) and stays unpinned by design.
const ALLOWED_EXTERNAL_HOST_PREFIXES = [
  'https://cdn.jsdelivr.net/npm/chart.js@4.4.4/',
  'https://cdn.jsdelivr.net/npm/flatpickr@4.6.13/',
  'https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/',
  'https://fonts.googleapis.com/',
];

// The SVG namespace URI is an XML namespace declaration (xmlns="..."), never fetched over the network
// — excluded so a fragment's inline <svg> markup doesn't false-positive as an external reference.
const SVG_NAMESPACE_URI = 'http://www.w3.org/2000/svg';

const externalUrlsIn = (html: string): string[] =>
  // Matches both absolute (https://host/...) and protocol-relative (//host/...) URLs — a
  // protocol-relative reference would still load an external host and must be caught too.
  (html.match(/(?:https?:)?\/\/[^"'\s)]+/g) ?? [])
    .map((url) => (url.startsWith('//') ? 'https:' + url : url))
    .filter((url) => url !== SVG_NAMESPACE_URI);

// Every `/api/...` path a fragment references via fetch() — literal or template-literal, dynamic
// segments included — with any query string stripped, since only the resource path matters here.
const apiPathsFetchedIn = (html: string): string[] => {
  const matches = [...html.matchAll(/["'`](\/api\/[^"'`]*)["'`]/g)];
  return [...new Set(matches.map(([, path]) => (path ?? '').split('?')[0] ?? ''))];
};

// Truncates a path at its first dynamic segment (`${` in a fragment's template literal, `{` in an
// OpenAPI path template), so a fetched `/api/transactions/${id}/confirm` can be compared against the
// documented `/api/transactions/{id}/confirm` on their shared static prefix, without matching param
// names one-for-one.
const staticPrefix = (path: string): string => path.split(/\$\{|\{/)[0] ?? '';

describe('default dashboard fragments are data-less (ADR-013 Phase B, converted to fragments by ADR-027)', () => {
  describe.each(DEFAULT_DASHBOARD_NAMES)('%s', (name) => {
    it('is a fragment that fetches its data from same-origin /api, embedding none of it', async () => {
      const res = await inject({ method: 'GET', url: `/api/dashboards/${name}` });
      expect(res.statusCode).toBe(200);
      const { html } = res.json() as { html: string };

      expect(html).toContain('fetch(');
      expect(html).not.toMatch(INLINE_DATA_BLOB_PATTERN);

      for (const url of externalUrlsIn(html)) {
        expect(
          ALLOWED_EXTERNAL_HOST_PREFIXES.some((prefix) => url.startsWith(prefix)),
          `unexpected external host: ${url}`,
        ).toBe(true);
      }

      // It's also not a full page — the shell (ui/shell.html) owns the document root now.
      expect(html).not.toMatch(/<!doctype html|<html[\s>]/i);
    });

    it('registers the live-update hook (ADR-027 Phase 3)', async () => {
      const res = await inject({ method: 'GET', url: `/api/dashboards/${name}` });
      const { html } = res.json() as { html: string };
      expect(html).toContain('window.fintrackOnDataChanged');
    });

    // Method-agnostic by design: apiPathsFetchedIn has no way to correlate a matched path string
    // with the HTTP method its own fetch() call used (GET load vs. POST/DELETE user actions mixed
    // into the same fragment), so this only catches a path that doesn't exist under ANY method —
    // not a real path called with the wrong one. Narrower than the single-dashboard version this
    // replaced, which checked GET specifically; traded off for coverage across all nine fragments.
    it('only fetches /api paths that exist in the live OpenAPI contract', async () => {
      const [dashboardRes, openApiRes] = await Promise.all([
        inject({ method: 'GET', url: `/api/dashboards/${name}` }),
        inject({ method: 'GET', url: '/api/openapi.json' }),
      ]);
      const { html } = dashboardRes.json() as { html: string };
      const documentedPrefixes = Object.keys(openApiRes.json().paths).map(staticPrefix);

      for (const path of apiPathsFetchedIn(html)) {
        expect(documentedPrefixes, `${path} not found in /api/openapi.json`).toContain(staticPrefix(path));
      }
    });
  });

  it("registers overview's live-update hook after its initial load call, not before", async () => {
    const res = await inject({ method: 'GET', url: '/api/dashboards/overview' });
    const { html } = res.json() as { html: string };

    // A stray SSE message arriving mid-init must never call a handler whose sections haven't
    // rendered yet, so the hook must be registered after the script's own initial load call.
    expect(html.indexOf('loadDashboardData();')).toBeGreaterThan(-1);
    expect(html.indexOf('loadDashboardData();')).toBeLessThan(html.indexOf('window.fintrackOnDataChanged ='));
  });

  it('covers every file-backed default with no drift', async () => {
    const res = await inject({ method: 'GET', url: '/api/dashboards' });
    const fileBackedNames = (res.json() as DashboardListItem[])
      .filter((d) => d.source === DashboardSource.enum.file)
      .map((d) => d.name)
      .sort();
    expect(fileBackedNames).toEqual([...DEFAULT_DASHBOARD_NAMES].sort());
  });
});

describe('app shell references only pinned CDN hosts (ADR-027)', () => {
  it('GET /ui references only pinned external hosts', async () => {
    const res = await inject({ method: 'GET', url: '/ui' });
    expect(res.statusCode).toBe(200);
    const html = res.body;

    const externalUrls = externalUrlsIn(html);
    expect(externalUrls.length).toBeGreaterThan(0);
    for (const url of externalUrls) {
      expect(
        ALLOWED_EXTERNAL_HOST_PREFIXES.some((prefix) => url.startsWith(prefix)),
        `unexpected external host: ${url}`,
      ).toBe(true);
    }
  });
});
