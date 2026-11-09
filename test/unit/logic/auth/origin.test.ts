import { describe, expect, it } from 'vitest';
import {
  allowedOrigins,
  csrfVerdict,
  declaredOrigin,
  isLoopbackRequest,
  isSameOrigin,
  isUnsafeMethod,
  preSessionCsrfVerdict,
  signInOrigin,
} from '../../../../src/logic/auth/origin.js';
import { authErrors } from '../../../../src/models/auth/errors.js';

describe('CSRF helpers', () => {
  it.each(['POST', 'PUT', 'PATCH', 'DELETE', 'post'])('treats %s as unsafe', (method) => {
    expect(isUnsafeMethod(method)).toBe(true);
  });

  it.each(['GET', 'HEAD', 'OPTIONS', 'get'])('treats %s as safe', (method) => {
    expect(isUnsafeMethod(method)).toBe(false);
  });

  it('reads the origin from Origin, else from the Referer', () => {
    expect(declaredOrigin('https://a.example', 'https://b.example/x')).toBe('https://a.example');
    expect(declaredOrigin(undefined, 'https://b.example/some/path?q=1')).toBe('https://b.example');
  });

  it('declares nothing for a missing, opaque or malformed origin', () => {
    expect(declaredOrigin(undefined, undefined)).toBeNull();
    expect(declaredOrigin('null', undefined)).toBeNull();
    expect(declaredOrigin('not a url', undefined)).toBeNull();
    expect(declaredOrigin(undefined, 'file:///etc/passwd')).toBeNull();
  });

  it('does not fall back to Referer when an Origin header is present', () => {
    expect(declaredOrigin('null', 'https://patty.example.com/ui')).toBeNull();
  });

  it('matches origins exactly — scheme, host and port', () => {
    const expected = 'https://patty.example.com';
    expect(isSameOrigin(expected, 'https://patty.example.com')).toBe(true);
    expect(isSameOrigin(expected, 'http://patty.example.com')).toBe(false);
    expect(isSameOrigin(expected, 'https://patty.example.com:8443')).toBe(false);
    expect(isSameOrigin(expected, 'https://patty.example.com.evil.example')).toBe(false);
    expect(isSameOrigin(expected, null)).toBe(false);
  });
});

describe('allowedOrigins (CSRF)', () => {
  const PUBLIC = 'https://patty.example.com';

  it('is PUBLIC_URL when it is set and the request came in on the public host', () => {
    expect(allowedOrigins(PUBLIC, 'patty.example.com')).toEqual([PUBLIC]);
  });

  it("also allows the request's own loopback origin (a local operator on the port publish)", () => {
    expect(allowedOrigins(PUBLIC, '127.0.0.1:51737')).toEqual([PUBLIC, 'http://127.0.0.1:51737']);
    expect(allowedOrigins(undefined, 'localhost:3001')).toEqual(['http://localhost:3001']);
    expect(allowedOrigins(undefined, '[::1]:3001')).toEqual(['http://[::1]:3001']);
  });

  it('never derives an origin from a non-loopback Host — a rebinding attacker controls it', () => {
    expect(allowedOrigins(undefined, 'attacker.example')).toEqual([]);
    expect(allowedOrigins(undefined, '192.168.1.10:51737')).toEqual([]);
    expect(allowedOrigins(PUBLIC, 'attacker.example')).toEqual([PUBLIC]);
  });

  it('is empty without a Host header or with a malformed one', () => {
    expect(allowedOrigins(undefined, undefined)).toEqual([]);
    expect(allowedOrigins(undefined, 'a b')).toEqual([]);
    expect(allowedOrigins(undefined, '127.0.0.1.evil.example')).toEqual([]);
  });
});

describe('csrfVerdict — a request that carries the session cookie', () => {
  const PUBLIC = 'https://patty.example.com';
  const request = (overrides: Partial<Parameters<typeof csrfVerdict>[0]> = {}) => ({
    method: 'POST',
    publicUrl: undefined as string | undefined,
    host: '127.0.0.1:51737',
    origin: undefined as string | undefined,
    referer: undefined as string | undefined,
    ...overrides,
  });

  it.each(['GET', 'HEAD', 'OPTIONS'])('lets a safe %s through whatever it declares', (method) => {
    expect(csrfVerdict(request({ method, origin: 'https://evil.example' }))).toBeNull();
    expect(csrfVerdict(request({ method, host: 'attacker.example' }))).toBeNull();
  });

  it.each(['POST', 'PUT', 'PATCH', 'DELETE'])('lets a same-origin %s through', (method) => {
    expect(csrfVerdict(request({ method, origin: 'http://127.0.0.1:51737' }))).toBeNull();
  });

  it('accepts the Referer when no Origin is sent', () => {
    expect(csrfVerdict(request({ referer: 'http://127.0.0.1:51737/ui/accounts' }))).toBeNull();
  });

  it('refuses an unsafe request that declares nothing', () => {
    expect(csrfVerdict(request())).toEqual(authErrors.crossOrigin);
  });

  it.each(['https://evil.example', 'http://127.0.0.1:9999', 'http://127.0.0.1:51737.evil.example', 'null'])(
    'refuses the cross-origin %j as crossOrigin',
    (origin) => {
      expect(csrfVerdict(request({ origin }))).toEqual(authErrors.crossOrigin);
    },
  );

  it('does not fall back to the Referer when an Origin header is present', () => {
    expect(csrfVerdict(request({ origin: 'https://evil.example', referer: 'http://127.0.0.1:51737/ui' }))).toEqual(
      authErrors.crossOrigin,
    );
  });

  it('answers unknownOrigin when the instance cannot name its own origin (non-loopback Host, no PUBLIC_URL)', () => {
    expect(csrfVerdict(request({ host: 'patty.lan:51737', origin: 'http://patty.lan:51737' }))).toEqual(
      authErrors.unknownOrigin,
    );
    expect(csrfVerdict(request({ host: undefined, origin: 'http://127.0.0.1:51737' }))).toEqual(
      authErrors.unknownOrigin,
    );
  });

  it('expects PUBLIC_URL when set — and still the loopback host it was reached on', () => {
    const behindProxy = { publicUrl: PUBLIC, host: 'patty.example.com' };
    expect(csrfVerdict(request({ ...behindProxy, origin: PUBLIC }))).toBeNull();
    expect(csrfVerdict(request({ ...behindProxy, origin: 'https://evil.example' }))).toEqual(authErrors.crossOrigin);
    expect(csrfVerdict(request({ publicUrl: PUBLIC, origin: 'http://127.0.0.1:51737' }))).toBeNull();
  });
});

describe('preSessionCsrfVerdict — login and setup POSTs', () => {
  const post = (origin?: string, referer?: string) => ({
    method: 'POST',
    publicUrl: undefined,
    host: '127.0.0.1:51737',
    origin,
    referer,
  });

  it('leaves a client that declares no origin alone (curl, scripts — no browser to defend)', () => {
    expect(preSessionCsrfVerdict(post())).toBeNull();
  });

  it('refuses a browser that declares a foreign origin or referer (forced login from a cross-site page)', () => {
    expect(preSessionCsrfVerdict(post('https://evil.example'))).toEqual(authErrors.crossOrigin);
    expect(preSessionCsrfVerdict(post(undefined, 'https://evil.example/login-form'))).toEqual(authErrors.crossOrigin);
  });

  it('accepts a declared origin that is ours', () => {
    expect(preSessionCsrfVerdict(post('http://127.0.0.1:51737'))).toBeNull();
  });

  it('never blocks a safe method', () => {
    expect(preSessionCsrfVerdict({ ...post('https://evil.example'), method: 'GET' })).toBeNull();
  });
});

describe('isLoopbackRequest — auth-disabled DNS-rebinding / cross-site guard', () => {
  it.each(['127.0.0.1:3001', '127.0.0.1', 'localhost:3001', 'LOCALHOST:51737', '[::1]:3001', '127.5.6.7:80'])(
    'answers a request whose Host is %s',
    (host) => {
      expect(isLoopbackRequest({ host, origin: undefined })).toBe(true);
    },
  );

  it.each([
    'attacker.example',
    'attacker.example:3001',
    '127.0.0.1.attacker.example',
    'localhost.attacker.example:3001',
    '192.168.1.10:3001',
    '0.0.0.0:3001',
    '[::]:3001',
    '[2001:db8::1]:3001',
  ])('refuses a request whose Host is %s (a rebound name or a non-loopback address)', (host) => {
    expect(isLoopbackRequest({ host, origin: undefined })).toBe(false);
  });

  it.each([
    undefined,
    '',
    'a b',
    'localhost:99999999',
    '127.0.0.1@attacker.example',
    'x@127.0.0.1',
    '127.0.0.1/x',
    '127.0.0.1?x',
    'localhost.', // a trailing-dot FQDN is refused: fail closed
    '://',
  ])('refuses a missing or malformed Host (%j)', (host) => {
    expect(isLoopbackRequest({ host, origin: undefined })).toBe(false);
  });

  it('does not require an Origin — native MCP clients, curl and stdio-adjacent tools send none', () => {
    expect(isLoopbackRequest({ host: '127.0.0.1:3001', origin: undefined })).toBe(true);
  });

  it.each([
    'http://localhost:6274', // MCP Inspector
    'http://127.0.0.1:3001',
    'https://localhost',
    'http://[::1]:3001',
    'http://127.0.0.2:8080',
  ])('accepts the loopback Origin %s, any port', (origin) => {
    expect(isLoopbackRequest({ host: '127.0.0.1:3001', origin })).toBe(true);
  });

  it.each([
    'https://evil.example',
    'http://evil.example:3001',
    'http://localhost.evil.example',
    'http://127.0.0.1.evil.example',
    'http://192.168.1.10:3001',
    'null', // opaque origin: a sandboxed iframe, a data: URL, a redirect chain
    '',
    'not a url',
    'ftp://localhost',
    'file:///etc/passwd',
    'chrome-extension://abcdef',
  ])('refuses the Origin %j even with a loopback Host', (origin) => {
    expect(isLoopbackRequest({ host: '127.0.0.1:3001', origin })).toBe(false);
  });

  it('needs BOTH to pass: a loopback Origin does not rescue a rebound Host', () => {
    expect(isLoopbackRequest({ host: 'attacker.example', origin: 'http://localhost:6274' })).toBe(false);
  });
});

describe('signInOrigin — what a stdio link may name from what the process already knows', () => {
  const base = { httpEnabled: true, publicUrl: undefined, boundOrigin: null, host: '127.0.0.1' };

  it('names nothing when there is no HTTP server', () => {
    expect(signInOrigin({ ...base, httpEnabled: false, publicUrl: 'https://fin.example.com' })).toBeNull();
  });

  it('prefers PUBLIC_URL, then the origin THIS process bound', () => {
    expect(signInOrigin({ ...base, publicUrl: 'https://fin.example.com', boundOrigin: 'http://127.0.0.1:1' })).toBe(
      'https://fin.example.com',
    );
    expect(signInOrigin({ ...base, boundOrigin: 'http://127.0.0.1:54321' })).toBe('http://127.0.0.1:54321');
  });

  it('never falls back to the configured HOST:PORT — whatever listens there may have opened another database', () => {
    expect(signInOrigin(base)).toBeNull();
    expect(signInOrigin({ ...base, host: 'localhost' })).toBeNull();
  });

  it('names no non-loopback host without PUBLIC_URL — its POSTs would fail the CSRF origin check', () => {
    expect(signInOrigin({ ...base, host: '0.0.0.0', boundOrigin: 'http://127.0.0.1:51737' })).toBeNull();
    expect(signInOrigin({ ...base, host: 'patty.lan', boundOrigin: 'http://patty.lan:51737' })).toBeNull();
    expect(signInOrigin({ ...base, host: '0.0.0.0', publicUrl: 'https://fin.example.com' })).toBe(
      'https://fin.example.com',
    );
  });
});
