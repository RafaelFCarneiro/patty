import { describe, expect, it } from 'vitest';
import { REDACTED, redactSecretQuery, SECRET_QUERY_PARAMS } from '../../../../src/logic/auth/redact.js';

describe('redactSecretQuery', () => {
  it('names the invite code parameter as a secret', () => {
    expect(SECRET_QUERY_PARAMS).toContain('code');
  });

  it.each([
    ['/ui/invite?code=ABCD-EFGH', `/ui/invite?code=${REDACTED}`],
    ['/ui/invite?x=1&code=ABCD-EFGH&y=2', `/ui/invite?x=1&code=${REDACTED}&y=2`],
    ['/ui/invite?CODE=abcd', `/ui/invite?CODE=${REDACTED}`],
    ['/ui/invite?code=a%20b#frag', `/ui/invite?code=${REDACTED}#frag`],
    ['/ui/invite?code=', `/ui/invite?code=${REDACTED}`],
    ['/ui/invite?%63ode=SECRET', `/ui/invite?%63ode=${REDACTED}`],
    ['/ui/invite?x=1&%43%6F%64%65=SECRET&y=2', `/ui/invite?x=1&%43%6F%64%65=${REDACTED}&y=2`],
    ['/ui/invite?code=a&code=b', `/ui/invite?code=${REDACTED}&code=${REDACTED}`],
  ])('redacts the value in %s', (url, expected) => {
    expect(redactSecretQuery(url)).toBe(expected);
  });

  it.each(['/ui/invite', '/api/accounts?name=code', '/ui/x?barcode=123', '/ui/overview?month=9'])(
    'leaves %s alone',
    (url) => {
      expect(redactSecretQuery(url)).toBe(url);
    },
  );
});
