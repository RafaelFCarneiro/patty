import { describe, expect, it } from 'vitest';
import { httpOrigin, isPortInUse, portInUseReason } from '../../../src/common/net.js';

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
  it.each(['0.0.0.0', '::'])('prints loopback for the wildcard host %s', (host) => {
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
