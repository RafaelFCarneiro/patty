import { describe, expect, it } from 'vitest';
import { REDACTED, redactSecretQuery, SECRET_QUERY_PARAMS } from '../../../../src/logic/auth/redact.js';

describe('redactSecretQuery', () => {
  it('names the invite code parameter as a secret', () => {
    expect(SECRET_QUERY_PARAMS).toContain('code');
  });

  it.each([
    ['/ui/access/invite?code=ABCD-EFGH', `/ui/access/invite?code=${REDACTED}`],
    ['/ui/access/invite?x=1&code=ABCD-EFGH&y=2', `/ui/access/invite?x=1&code=${REDACTED}&y=2`],
    ['/ui/access/invite?CODE=abcd', `/ui/access/invite?CODE=${REDACTED}`],
    ['/ui/access/invite?code=a%20b#frag', `/ui/access/invite?code=${REDACTED}#frag`],
    ['/ui/access/invite?code=', `/ui/access/invite?code=${REDACTED}`],
    ['/ui/access/invite?%63ode=SECRET', `/ui/access/invite?%63ode=${REDACTED}`],
    ['/ui/access/invite?x=1&%43%6F%64%65=SECRET&y=2', `/ui/access/invite?x=1&%43%6F%64%65=${REDACTED}&y=2`],
    ['/ui/access/invite?code=a&code=b', `/ui/access/invite?code=${REDACTED}&code=${REDACTED}`],
  ])('redacts the value in %s', (url, expected) => {
    expect(redactSecretQuery(url)).toBe(expected);
  });

  it.each(['/ui/access/invite', '/api/accounts?name=code', '/ui/x?barcode=123', '/ui/overview?month=9'])(
    'leaves %s alone',
    (url) => {
      expect(redactSecretQuery(url)).toBe(url);
    },
  );
});
