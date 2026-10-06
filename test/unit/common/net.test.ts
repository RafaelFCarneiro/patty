import { describe, expect, it } from 'vitest';
import {
  httpOrigin,
  IPV4_WILDCARD_HOST,
  IPV6_WILDCARD_HOST,
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
    expect(message).toContain('PORT=3002 fintrack');
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
