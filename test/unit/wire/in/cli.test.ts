import { describe, expect, it } from 'vitest';
import { ClaimOptionsSchema, ResetOptionsSchema } from '../../../../src/wire/in/cli.js';

describe('ClaimOptionsSchema', () => {
  it('defaults to asking for the password, with no username', () => {
    expect(ClaimOptionsSchema.parse({})).toEqual({ passwordStdin: false, username: undefined });
  });

  it('reads --password-stdin and normalizes --username like the setup form does', () => {
    expect(ClaimOptionsSchema.parse({ 'password-stdin': true, username: '  Rafael ' })).toEqual({
      passwordStdin: true,
      username: 'rafael',
    });
  });

  it.each(['ab', 'has space', 'x'.repeat(65)])('rejects the username %j with the policy message', (username) => {
    expect(ClaimOptionsSchema.safeParse({ username }).success).toBe(false);
  });
});

describe('ResetOptionsSchema', () => {
  it('defaults to the owner and normalizes --user', () => {
    expect(ResetOptionsSchema.parse({})).toEqual({ passwordStdin: false, user: undefined });
    expect(ResetOptionsSchema.parse({ user: ' Ana ', 'password-stdin': true })).toEqual({
      passwordStdin: true,
      user: 'ana',
    });
  });

  it('does not police the shape of --user: an unknown name is a clear "no such user", not a validation error', () => {
    expect(ResetOptionsSchema.parse({ user: 'a' }).user).toBe('a');
  });

  it('rejects an empty --user', () => {
    expect(ResetOptionsSchema.safeParse({ user: '' }).success).toBe(false);
  });
});
