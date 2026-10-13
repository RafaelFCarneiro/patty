import { describe, expect, it } from 'vitest';
import {
  acceptsBearer,
  bearerChallenge,
  credentialOf,
  protectedResourceMetadata,
  resourceMetadataUrl,
} from '../../../../src/logic/auth/bearer.js';
import { resourceOrigin } from '../../../../src/logic/auth/origin.js';
import { authErrors } from '../../../../src/models/auth/errors.js';
import { ALL_SCOPES, Scope } from '../../../../src/models/auth/scope.js';

const METADATA_URL = 'https://fin.example.com/.well-known/oauth-protected-resource/mcp';

const WRITE = Scope.enum['fintrack:write'];

describe('credentialOf — an Authorization header is authoritative', () => {
  it('is none only when the header is absent', () => {
    expect(credentialOf(undefined)).toEqual({ kind: 'none' });
  });

  it('accepts Bearer ftk_… in any case of the scheme', () => {
    expect(credentialOf('Bearer ftk_abc')).toEqual({ kind: 'bearer', token: 'ftk_abc' });
    expect(credentialOf('bearer ftk_abc')).toEqual({ kind: 'bearer', token: 'ftk_abc' });
    expect(credentialOf('BEARER   ftk_abc')).toEqual({ kind: 'bearer', token: 'ftk_abc' });
  });

  it.each([
    '',
    'Bearer',
    'Bearer ',
    'Bearer notours',
    'Bearer ftk_a b',
    'Basic Zm9vOmJhcg==',
    'ftk_abc',
    `Bearer ftk_${'a'.repeat(300)}`,
  ])('is malformed — never a reason to try the cookie (%j)', (header) => {
    expect(credentialOf(header)).toEqual({ kind: 'malformed' });
  });
});

describe('acceptsBearer', () => {
  it('takes /api and /mcp, never /ui', () => {
    for (const path of ['/api', '/api/accounts', '/mcp']) expect(acceptsBearer(path)).toBe(true);
    for (const path of ['/ui', '/ui/access/tokens', '/ui/events', '/apix', '/mcpx', '/', '/health']) {
      expect(acceptsBearer(path)).toBe(false);
    }
  });
});

describe('bearerChallenge (RFC 6750 §3, MCP authorization)', () => {
  it('no credential: resource_metadata and every scope', () => {
    expect(bearerChallenge(authErrors.unauthenticated, METADATA_URL)).toBe(
      `Bearer resource_metadata="${METADATA_URL}", scope="fintrack:read fintrack:write"`,
    );
  });

  it('invalid token: error="invalid_token" plus resource_metadata', () => {
    expect(bearerChallenge(authErrors.invalidToken, METADATA_URL)).toBe(
      `Bearer error="invalid_token", resource_metadata="${METADATA_URL}"`,
    );
  });

  it('insufficient scope: error, the scope that was needed, resource_metadata', () => {
    expect(bearerChallenge(authErrors.insufficientScope(WRITE), METADATA_URL)).toBe(
      `Bearer error="insufficient_scope", scope="fintrack:write", resource_metadata="${METADATA_URL}"`,
    );
  });

  it('leaves resource_metadata out when the instance cannot name its origin', () => {
    expect(bearerChallenge(authErrors.unauthenticated, null)).toBe('Bearer scope="fintrack:read fintrack:write"');
    expect(bearerChallenge(authErrors.invalidToken, null)).toBe('Bearer error="invalid_token"');
  });

  it('escapes quotes and backslashes in a value', () => {
    expect(bearerChallenge(authErrors.invalidToken, 'https://x/"\\y')).toBe(
      'Bearer error="invalid_token", resource_metadata="https://x/\\"\\\\y"',
    );
  });
});

describe('Protected Resource Metadata (RFC 9728)', () => {
  it('puts the metadata of <origin>/mcp at the path-inserted well-known URI', () => {
    expect(resourceMetadataUrl('https://fin.example.com')).toBe(METADATA_URL);
  });

  it('describes the MCP resource: scopes, header bearer, no authorization server yet, no offline_access', () => {
    const document = protectedResourceMetadata('https://fin.example.com');
    expect(document).toEqual({
      resource: 'https://fin.example.com/mcp',
      scopes_supported: [...ALL_SCOPES],
      bearer_methods_supported: ['header'],
      resource_name: 'FinTrack',
    });
    expect(document).not.toHaveProperty('authorization_servers');
    expect(JSON.stringify(document)).not.toContain('offline_access');
  });

  it('takes the origin from PUBLIC_URL, else the request’s own loopback origin, else nothing', () => {
    expect(resourceOrigin('https://fin.example.com', '127.0.0.1:51737')).toBe('https://fin.example.com');
    expect(resourceOrigin(undefined, '127.0.0.1:51737')).toBe('http://127.0.0.1:51737');
    expect(resourceOrigin(undefined, 'localhost:3001')).toBe('http://localhost:3001');
    expect(resourceOrigin(undefined, 'fin.lan:51737')).toBeNull();
    expect(resourceOrigin(undefined, undefined)).toBeNull();
  });
});
