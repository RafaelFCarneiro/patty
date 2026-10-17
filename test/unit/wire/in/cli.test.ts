import { describe, expect, it } from 'vitest';
import {
  ClaimOptionsSchema,
  CliCommand,
  InviteOptionsSchema,
  ResetOptionsSchema,
  TargetUsernameSchema,
  USERS_POSITIONALS,
  UsersSubcommand,
} from '../../../../src/wire/in/cli.js';

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

  it.each(['', '   ', '\t\n'])('rejects an empty or whitespace-only --user (%j)', (user) => {
    expect(ResetOptionsSchema.safeParse({ user }).success).toBe(false);
  });
});

describe('the users command grammar', () => {
  it('is a command of the CLI with six subcommands', () => {
    expect(CliCommand.options).toContain('users');
    expect(UsersSubcommand.options).toEqual(['list', 'invite', 'reissue', 'disable', 'enable', 'role']);
  });

  it('says how many positionals each subcommand takes: every subcommand is covered', () => {
    expect(Object.keys(USERS_POSITIONALS).sort()).toEqual([...UsersSubcommand.options].sort());
    expect(USERS_POSITIONALS).toEqual({ list: 0, invite: 1, reissue: 1, disable: 1, enable: 1, role: 2 });
  });

  it('invites members unless --admin', () => {
    expect(InviteOptionsSchema.parse({})).toEqual({ role: 'member' });
    expect(InviteOptionsSchema.parse({ admin: true })).toEqual({ role: 'admin' });
  });

  it('only normalizes a username named on the command line', () => {
    expect(TargetUsernameSchema.parse('  ANA ')).toBe('ana');
    expect(TargetUsernameSchema.safeParse('   ').success).toBe(false);
    expect(TargetUsernameSchema.safeParse(undefined).success).toBe(false);
  });
});
