import { describe, expect, it } from 'vitest';
import {
  acceptsBearer,
  bearerChallenge,
  credentialOf,
  defaultScopeForMethod,
  evaluateToken,
  hasScope,
  newAccessToken,
  protectedResourceMetadata,
  requiredMcpScope,
  resourceMetadataUrl,
  resourceOrigin,
  revokedToken,
  scopeOfTool,
  SESSION_TOUCH_INTERVAL_MS,
  summarizeToken,
  tokenDisplayPrefix,
  tokenPrincipal,
  tokenStatus,
  usedToken,
} from '../../../src/logic/auth.js';
import {
  ALL_SCOPES,
  authErrors,
  OWNER_USER_ID,
  PrincipalVia,
  Scope,
  TokenStatus,
  UserRole,
  type AccessTokenEntity,
  type UserEntity,
} from '../../../src/models/auth.js';

const NOW = new Date('2026-10-09T12:00:00.000Z');
const DAY_MS = 24 * 60 * 60 * 1000;
const READ = Scope.enum['fintrack:read'];
const WRITE = Scope.enum['fintrack:write'];
const METADATA_URL = 'https://fin.example.com/.well-known/oauth-protected-resource/mcp';

const owner = (overrides: Partial<UserEntity> = {}): UserEntity => ({
  id: OWNER_USER_ID,
  username: 'rafael',
  passwordHash: 'hash',
  role: UserRole.enum.admin,
  createdAt: NOW.toISOString(),
  disabledAt: null,
  version: 1,
  ...overrides,
});

const token = (overrides: Partial<AccessTokenEntity> = {}): AccessTokenEntity => ({
  id: 't1',
  userId: OWNER_USER_ID,
  name: 'laptop',
  tokenHash: 'sha(ftk_x)',
  prefix: 'ftk_abcdef',
  scopes: [READ],
  createdAt: NOW.toISOString(),
  lastUsedAt: null,
  expiresAt: null,
  revokedAt: null,
  version: 0,
  ...overrides,
});

describe('hasScope', () => {
  it('lets write imply read, and nothing imply write', () => {
    expect(hasScope([WRITE], READ)).toBe(true);
    expect(hasScope([READ], READ)).toBe(true);
    expect(hasScope([WRITE], WRITE)).toBe(true);
    expect(hasScope([READ], WRITE)).toBe(false);
    expect(hasScope([], READ)).toBe(false);
  });

  it('ignores scope strings it does not know', () => {
    expect(hasScope(['offline_access', 'admin'], READ)).toBe(false);
  });
});

describe('the REST scope default rule', () => {
  it.each([
    ['GET', READ],
    ['get', READ],
    ['HEAD', READ],
    ['POST', WRITE],
    ['PATCH', WRITE],
    ['DELETE', WRITE],
    ['PUT', WRITE],
    ['OPTIONS', WRITE], // anything not plainly a read fails closed
  ])('%s needs %s', (method, scope) => {
    expect(defaultScopeForMethod(method)).toBe(scope);
  });
});

describe('scopeOfTool', () => {
  it('derives read only from an explicit readOnlyHint of true', () => {
    expect(scopeOfTool(true)).toBe(READ);
    expect(scopeOfTool(false)).toBe(WRITE);
    expect(scopeOfTool(undefined)).toBe(WRITE);
  });
});

describe('requiredMcpScope', () => {
  const scopes = new Map([
    ['list_accounts', READ],
    ['create_account', WRITE],
  ]);
  const lookup = (name: string) => scopes.get(name);
  const call = (name: unknown) => ({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name } });

  it('needs only read for protocol methods that run no tool', () => {
    for (const method of ['initialize', 'tools/list', 'resources/read', 'prompts/get', 'ping']) {
      expect(requiredMcpScope({ jsonrpc: '2.0', id: 1, method }, lookup)).toBe(READ);
    }
    expect(requiredMcpScope({ jsonrpc: '2.0', method: 'notifications/initialized' }, lookup)).toBe(READ);
  });

  it('follows the called tool', () => {
    expect(requiredMcpScope(call('list_accounts'), lookup)).toBe(READ);
    expect(requiredMcpScope(call('create_account'), lookup)).toBe(WRITE);
  });

  it('fails closed on a tool it cannot place or a call it cannot read', () => {
    expect(requiredMcpScope(call('no_such_tool'), lookup)).toBe(WRITE);
    expect(requiredMcpScope(call(undefined), lookup)).toBe(WRITE);
    expect(requiredMcpScope({ jsonrpc: '2.0', id: 1, method: 'tools/call' }, lookup)).toBe(WRITE);
  });

  it('needs write when any message of a batch does', () => {
    expect(requiredMcpScope([call('list_accounts'), call('list_accounts')], lookup)).toBe(READ);
    expect(requiredMcpScope([call('list_accounts'), call('create_account')], lookup)).toBe(WRITE);
  });

  it('treats a body that is not JSON-RPC as running nothing', () => {
    for (const body of [undefined, null, 'x', 7, [], [null]]) {
      expect(requiredMcpScope(body, lookup)).toBe(READ);
    }
  });
});

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

describe('new tokens', () => {
  const fields = { id: 't1', userId: OWNER_USER_ID, tokenHash: 'h', prefix: 'ftk_abcdef' };

  it('keeps only ftk_ + the first characters of the random part for display', () => {
    expect(tokenDisplayPrefix('ftk_abcdefghijklmnop')).toBe('ftk_abcdef');
  });

  it('read access is the read scope; write access includes read', () => {
    expect(newAccessToken({ ...fields, input: { name: 'n', access: 'read', expiry: '90' } }, NOW).scopes).toEqual([
      READ,
    ]);
    expect(newAccessToken({ ...fields, input: { name: 'n', access: 'write', expiry: '90' } }, NOW).scopes).toEqual([
      READ,
      WRITE,
    ]);
  });

  it.each([
    ['30', 30],
    ['90', 90],
    ['365', 365],
  ] as const)('expiry %s', (expiry, days) => {
    const created = newAccessToken({ ...fields, input: { name: 'n', access: 'read', expiry } }, NOW);
    expect(created.expiresAt).toBe(new Date(NOW.getTime() + days * DAY_MS).toISOString());
    expect(created).toMatchObject({ lastUsedAt: null, revokedAt: null, createdAt: NOW.toISOString() });
  });
});

describe('tokenStatus and summarizeToken', () => {
  it('is active until revoked or expired; revoked wins', () => {
    expect(tokenStatus(token(), NOW)).toBe(TokenStatus.enum.active);
    expect(tokenStatus(token({ expiresAt: new Date(NOW.getTime() + 1).toISOString() }), NOW)).toBe('active');
    expect(tokenStatus(token({ expiresAt: NOW.toISOString() }), NOW)).toBe(TokenStatus.enum.expired);
    expect(tokenStatus(token({ revokedAt: NOW.toISOString() }), NOW)).toBe(TokenStatus.enum.revoked);
    expect(tokenStatus(token({ revokedAt: NOW.toISOString(), expiresAt: NOW.toISOString() }), NOW)).toBe('revoked');
  });

  it('never carries the hash or the version', () => {
    const summary = summarizeToken(token(), NOW);
    expect(summary).not.toHaveProperty('tokenHash');
    expect(summary).not.toHaveProperty('version');
    expect(JSON.stringify(summary)).not.toContain('sha(');
    expect(summary).toMatchObject({ id: 't1', name: 'laptop', prefix: 'ftk_abcdef', status: 'active' });
  });
});

describe('evaluateToken — the verdict', () => {
  it('is valid for an active token of a claimed, enabled owner', () => {
    expect(evaluateToken(token(), owner(), NOW)).toEqual({ kind: 'valid', touch: true });
  });

  it.each([
    ['unknown', null, owner()],
    ['revoked', token({ revokedAt: NOW.toISOString() }), owner()],
    ['expired', token({ expiresAt: NOW.toISOString() }), owner()],
    ['owner missing', token(), null],
    ['owner unclaimed', token(), owner({ username: null, passwordHash: null })],
    ['owner disabled', token(), owner({ disabledAt: NOW.toISOString() })],
  ])('is invalid when %s', (_label, entity, user) => {
    expect(evaluateToken(entity, user, NOW)).toEqual({ kind: 'invalid' });
  });

  it('touches last_used_at only when it is stale, with the session interval', () => {
    const used = token({ lastUsedAt: NOW.toISOString() });
    const justBefore = new Date(NOW.getTime() + SESSION_TOUCH_INTERVAL_MS - 1);
    const atInterval = new Date(NOW.getTime() + SESSION_TOUCH_INTERVAL_MS);
    expect(evaluateToken(used, owner(), NOW)).toEqual({ kind: 'valid', touch: false });
    expect(evaluateToken(used, owner(), justBefore)).toEqual({ kind: 'valid', touch: false });
    expect(evaluateToken(used, owner(), atInterval)).toEqual({ kind: 'valid', touch: true });
  });

  it('builds the principal from the token, not the user', () => {
    expect(tokenPrincipal(token({ scopes: [READ] }), owner())).toEqual({
      userId: OWNER_USER_ID,
      role: UserRole.enum.admin,
      scopes: [READ],
      via: PrincipalVia.enum.token,
      tokenId: 't1',
    });
  });

  it('marks use and revocation without touching anything else', () => {
    expect(usedToken(token(), NOW)).toEqual({ ...token(), lastUsedAt: NOW.toISOString() });
    expect(revokedToken(token(), NOW)).toEqual({ ...token(), revokedAt: NOW.toISOString() });
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
