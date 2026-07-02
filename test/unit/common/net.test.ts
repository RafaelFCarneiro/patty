import { describe, expect, it } from 'vitest';
import { isPortInUse } from '../../../src/common/net.js';

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
