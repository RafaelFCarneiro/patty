import { describe, expect, it } from 'vitest';
import {
  CLIENT_NAME_MAX_LENGTH,
  CLIENT_VERSION_MAX_LENGTH,
  UNKNOWN_CLIENT_NAME,
  UNKNOWN_CLIENT_VERSION,
} from '../../../../src/models/auth.js';
import { clientInfoOf, ConnectFormSchema, ConnectQuerySchema } from '../../../../src/wire/in/auth.js';

describe('clientInfoOf — what the spawning program says about itself is cleaned, not trusted', () => {
  it('passes a well-formed clientInfo through', () => {
    expect(clientInfoOf({ name: 'Claude Desktop', version: '1.2.3' })).toEqual({
      name: 'Claude Desktop',
      version: '1.2.3',
    });
  });

  it('falls back when nothing was reported yet', () => {
    expect(clientInfoOf(undefined)).toEqual({ name: UNKNOWN_CLIENT_NAME, version: UNKNOWN_CLIENT_VERSION });
    expect(clientInfoOf({})).toEqual({ name: UNKNOWN_CLIENT_NAME, version: UNKNOWN_CLIENT_VERSION });
  });

  it('falls back on values of the wrong type, or empty after trimming', () => {
    expect(clientInfoOf({ name: 42, version: ['1'] })).toEqual({
      name: UNKNOWN_CLIENT_NAME,
      version: UNKNOWN_CLIENT_VERSION,
    });
    expect(clientInfoOf({ name: '   ', version: '' })).toEqual({
      name: UNKNOWN_CLIENT_NAME,
      version: UNKNOWN_CLIENT_VERSION,
    });
    expect(clientInfoOf('not an object')).toEqual({ name: UNKNOWN_CLIENT_NAME, version: UNKNOWN_CLIENT_VERSION });
  });

  it('turns control characters into spaces (no line breaks to forge a second line) and bounds the length', () => {
    const cleaned = clientInfoOf({ name: `Evil\nApprove\r\tthis${'x'.repeat(500)}`, version: 'v'.repeat(500) });
    expect(cleaned.name).not.toMatch(/[\u0000-\u001f]/);
    expect(cleaned.name.length).toBeLessThanOrEqual(CLIENT_NAME_MAX_LENGTH);
    expect(cleaned.version).toHaveLength(CLIENT_VERSION_MAX_LENGTH);
  });
});

describe('ConnectQuerySchema / ConnectFormSchema', () => {
  it('reads the code from the query and ignores anything else', () => {
    expect(ConnectQuerySchema.parse({ code: 'ABCD-EFGH', other: 'x' })).toEqual({ code: 'ABCD-EFGH' });
    expect(ConnectQuerySchema.parse({})).toEqual({});
    expect(ConnectQuerySchema.parse({ code: 'x'.repeat(100) })).toEqual({});
  });

  it('accepts exactly the form the page posts', () => {
    expect(
      ConnectFormSchema.parse({ code: 'ABCD-EFGH', decision: 'approve', access: 'write', duration: '7d' }),
    ).toEqual({ code: 'ABCD-EFGH', decision: 'approve', access: 'write', duration: '7d' });
  });

  it.each([
    { code: 'ABCD-EFGH', decision: 'maybe', access: 'read', duration: '24h' },
    { code: 'ABCD-EFGH', decision: 'approve', access: 'admin', duration: '24h' },
    { code: 'ABCD-EFGH', decision: 'approve', access: 'read', duration: 'forever' },
    { code: '', decision: 'deny', access: 'read', duration: '24h' },
    { decision: 'deny', access: 'read', duration: '24h' },
  ])('rejects %j', (form) => {
    expect(ConnectFormSchema.safeParse(form).success).toBe(false);
  });
});
