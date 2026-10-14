import { describe, expect, it } from 'vitest';
import { MCP_PRM_PATH, PRM_WELL_KNOWN_PATH } from '../../../src/models/auth/bearer.js';
import { AUTH_MESSAGES } from '../../../src/models/auth/message.js';
import { AuthMode } from '../../../src/models/auth/mode.js';
import { ALL_SCOPES } from '../../../src/models/auth/scope.js';
import { claimOwner, LOOPBACK_HOST, LOOPBACK_ORIGIN, useAuthApp } from './helpers.js';

const createApp = useAuthApp();

const PUBLIC_URL = 'https://fin.example.com';
const BOTH_PATHS = [PRM_WELL_KNOWN_PATH, MCP_PRM_PATH];

describe('Protected Resource Metadata (RFC 9728)', () => {
  it.each(BOTH_PATHS)('serves the document at %s with no credential at all', async (url) => {
    const ctx = await createApp({ auth: { PUBLIC_URL } });
    await claimOwner(ctx);
    const res = await ctx.app.inject({ method: 'GET', url, headers: { host: LOOPBACK_HOST } });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('application/json');
    expect(res.json()).toEqual({
      resource: `${PUBLIC_URL}/mcp`,
      scopes_supported: [...ALL_SCOPES],
      bearer_methods_supported: ['header'],
      resource_name: 'FinTrack',
    });
  });

  it('serves the same document on both paths, and answers HEAD', async () => {
    const ctx = await createApp({ auth: { PUBLIC_URL } });
    const [bare, inserted] = await Promise.all(
      BOTH_PATHS.map((url) => ctx.app.inject({ method: 'GET', url, headers: { host: LOOPBACK_HOST } })),
    );
    expect(bare?.body).toBe(inserted?.body);
    expect(
      (await ctx.app.inject({ method: 'HEAD', url: MCP_PRM_PATH, headers: { host: LOOPBACK_HOST } })).statusCode,
    ).toBe(200);
  });

  it('lists no authorization server (Phase 3) and never offline_access', async () => {
    const ctx = await createApp({ auth: { PUBLIC_URL } });
    const body = (await ctx.app.inject({ method: 'GET', url: MCP_PRM_PATH, headers: { host: LOOPBACK_HOST } })).body;
    expect(body).not.toContain('authorization_servers');
    expect(body).not.toContain('offline_access');
  });

  it('names PUBLIC_URL as the origin, whatever Host the request arrived with', async () => {
    const ctx = await createApp({ auth: { PUBLIC_URL } });
    const res = await ctx.app.inject({ method: 'GET', url: MCP_PRM_PATH, headers: { host: 'attacker.example' } });
    expect(res.json().resource).toBe(`${PUBLIC_URL}/mcp`);
  });

  it('falls back to the request’s own loopback origin when there is no PUBLIC_URL', async () => {
    const ctx = await createApp();
    const res = await ctx.app.inject({ method: 'GET', url: MCP_PRM_PATH, headers: { host: LOOPBACK_HOST } });
    expect(res.json().resource).toBe(`${LOOPBACK_ORIGIN}/mcp`);
  });

  it.each(BOTH_PATHS)(
    'is a 404 with the PUBLIC_URL hint at %s when the instance cannot name its origin',
    async (url) => {
      const ctx = await createApp();
      const res = await ctx.app.inject({ method: 'GET', url, headers: { host: 'fin.lan:51737' } });
      expect(res.statusCode).toBe(404);
      expect(res.json()).toEqual({
        error: { code: 'resource_metadata_unavailable', hint: AUTH_MESSAGES.prmNeedsOrigin },
      });
      expect(AUTH_MESSAGES.prmNeedsOrigin).toContain('PUBLIC_URL');
    },
  );

  it('is not served when auth is disabled — there is no authorization to describe', async () => {
    const ctx = await createApp({ auth: { FINTRACK_AUTH: AuthMode.enum.disabled } });
    for (const url of BOTH_PATHS) {
      expect((await ctx.app.inject({ method: 'GET', url, headers: { host: LOOPBACK_HOST } })).statusCode, url).toBe(
        404,
      );
    }
  });

  it('is the URL a 401 challenge points at, and it resolves', async () => {
    const ctx = await createApp({ auth: { PUBLIC_URL } });
    const challenged = await ctx.app.inject({
      method: 'POST',
      url: '/mcp',
      headers: { host: LOOPBACK_HOST },
      payload: {},
    });
    const header = String(challenged.headers['www-authenticate']);
    const url = /resource_metadata="([^"]+)"/.exec(header)?.[1];
    expect(url).toBe(`${PUBLIC_URL}${MCP_PRM_PATH}`);

    const document = await ctx.app.inject({
      method: 'GET',
      url: new URL(url ?? '').pathname,
      headers: { host: LOOPBACK_HOST },
    });
    expect(document.statusCode).toBe(200);
    // RFC 9728 §3.3: `resource` must be the identifier the metadata URL was built from.
    expect(document.json().resource).toBe(`${PUBLIC_URL}/mcp`);
  });
});
