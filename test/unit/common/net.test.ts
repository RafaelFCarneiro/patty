import { describe, expect, it } from 'vitest';
import {
  hostnameOfHostHeader,
  httpOrigin,
  IPV4_WILDCARD_HOST,
  IPV6_WILDCARD_HOST,
  isLoopbackHost,
  isPortInUse,
  portInUseMessage,
  portInUseReason,
} from '../../../src/common/net.js';

describe('isPortInUse', () => {
  it('recognizes an EADDRINUSE error carrying a port number', () => {
    expect(isPortInUse({ code: 'EADDRINUSE', port: 3001 })).toBe(true);
  });

  it('rejects errors with a different code', () => {
    expect(isPortInUse({ code: 'ECONNREFUSED', port: 3001 })).toBe(false);
  });

  it('rejects an EADDRINUSE error missing a numeric port', () => {
    expect(isPortInUse({ code: 'EADDRINUSE' })).toBe(false);
    expect(isPortInUse({ code: 'EADDRINUSE', port: '3001' })).toBe(false);
  });

  it('rejects non-object values', () => {
    expect(isPortInUse(null)).toBe(false);
    expect(isPortInUse(undefined)).toBe(false);
    expect(isPortInUse('EADDRINUSE')).toBe(false);
  });
});

describe('portInUseReason', () => {
  it('names the port in a human-readable reason', () => {
    expect(portInUseReason(3001)).toBe('port 3001 is already in use (another service or MCP server is on it)');
  });
});

describe('httpOrigin', () => {
  it.each([IPV4_WILDCARD_HOST, IPV6_WILDCARD_HOST])('prints loopback for the wildcard host %s', (host) => {
    expect(httpOrigin(host, 51737)).toBe('http://127.0.0.1:51737');
  });

  it('prints an explicit host as itself', () => {
    expect(httpOrigin('192.168.1.10', 3001)).toBe('http://192.168.1.10:3001');
    expect(httpOrigin('127.0.0.1', 3001)).toBe('http://127.0.0.1:3001');
  });

  it('brackets an explicit IPv6 literal', () => {
    expect(httpOrigin('::1', 3001)).toBe('http://[::1]:3001');
  });
});

describe('portInUseMessage', () => {
  it('points the client at the default loopback when the error carries no address', () => {
    const message = portInUseMessage({ port: 3001 });
    expect(message).toContain(portInUseReason(3001));
    expect(message).toContain('PORT=3002 patty');
    expect(message).toContain('http://127.0.0.1:3002/mcp');
  });

  it('prints a reachable loopback URL when the bind address was a wildcard', () => {
    expect(portInUseMessage({ port: 51737, address: IPV4_WILDCARD_HOST })).toContain('http://127.0.0.1:51738/mcp');
  });

  it('prints an explicit bind address as itself, bracketing IPv6', () => {
    expect(portInUseMessage({ port: 3001, address: '192.168.1.10' })).toContain('http://192.168.1.10:3002/mcp');
    expect(portInUseMessage({ port: 3001, address: '::1' })).toContain('http://[::1]:3002/mcp');
  });
});

describe('isLoopbackHost (ADR-033 §1)', () => {
  it.each(['127.0.0.1', '127.0.0.2', '127.255.255.255', 'localhost', 'LOCALHOST', '::1', '[::1]', ' 127.0.0.1 '])(
    'treats %s as loopback',
    (host) => {
      expect(isLoopbackHost(host)).toBe(true);
    },
  );

  it.each([
    '0.0.0.0',
    '::',
    '192.168.1.10',
    '10.0.0.1',
    '128.0.0.1',
    '127.0.0.256',
    '127.0.0',
    '127.0.0.1.evil.example',
    'localhost.evil.example',
    'evil-localhost',
    '',
    '::2',
  ])('does not treat %s as loopback', (host) => {
    expect(isLoopbackHost(host)).toBe(false);
  });
});

describe('hostnameOfHostHeader', () => {
  it.each([
    ['127.0.0.1:51737', '127.0.0.1'],
    ['localhost', 'localhost'],
    ['[::1]:51737', '::1'],
    ['patty.example.com:8443', 'patty.example.com'],
  ])('extracts the hostname of %s', (header, hostname) => {
    expect(hostnameOfHostHeader(header)).toBe(hostname);
  });

  it.each([
    '',
    'a b',
    'localhost:99999999',
    'evil.example/path@127.0.0.1',
    'x@127.0.0.1', // userinfo: not an authority
    'evil@127.0.0.1:3001',
    '127.0.0.1/x', // path
    '127.0.0.1\\@evil', // a backslash starts the path in a special-scheme URL
    '127.0.0.1?x',
    '127.0.0.1#x',
  ])('returns null for a malformed header %j', (header) => {
    expect(hostnameOfHostHeader(header)).toBeNull();
  });

  it.each([
    ['127.1', '127.0.0.1'], // the URL parser's own IPv4 normalization
    ['2130706433', '127.0.0.1'],
    ['LOCALHOST:3001', 'localhost'],
    ['localhost.', 'localhost.'], // an FQDN dot stays distinct: isLoopbackHost refuses it (fails closed)
  ])('normalizes the well-formed %s the way the URL parser does', (header, hostname) => {
    expect(hostnameOfHostHeader(header)).toBe(hostname);
  });
});
