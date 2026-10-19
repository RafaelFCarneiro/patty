import { z } from 'zod';
import { LoginDuration } from '../../models/auth/grant.js';
import { UserRole } from '../../models/auth/owner.js';
import { UsernameSchema, normalizeUsername } from '../../models/auth/password.js';
import { DEFAULT_PROFILE, ProfileSchema } from '../../models/auth/signIn.js';
import { TokenAccess } from '../../models/auth/token.js';

/** The CLI's argv grammar: the commands, their subcommands, their flags and how many positionals each takes. */
export const PASSWORD_STDIN_FLAG = 'password-stdin';

/** How many positional arguments each command takes: `setup` names one client, the `auth` subcommands none. */
export const SETUP_POSITIONALS = 1;
export const AUTH_POSITIONALS = 0;
/** `login` and `logout` take flags only. */
export const SIGN_IN_POSITIONALS = 0;

export const CliCommand = z.enum(['setup', 'auth', 'login', 'logout', 'users']);
export type CliCommand = z.infer<typeof CliCommand>;

export const AuthSubcommand = z.enum(['setup', 'reset-password']);
export type AuthSubcommand = z.infer<typeof AuthSubcommand>;

const OPTION_MAX_LENGTH = 256;

export const ClaimOptionsSchema = z
  .object({
    [PASSWORD_STDIN_FLAG]: z.boolean().default(false),
    username: UsernameSchema.optional(),
  })
  .transform((flags) => ({ passwordStdin: flags[PASSWORD_STDIN_FLAG], username: flags.username }));
export type ClaimOptions = z.infer<typeof ClaimOptionsSchema>;

/** `--user` is only normalized: an unknown name is a clear "no such user", not a validation failure. */
export const ResetOptionsSchema = z
  .object({
    [PASSWORD_STDIN_FLAG]: z.boolean().default(false),
    user: z.string().transform(normalizeUsername).pipe(z.string().min(1).max(OPTION_MAX_LENGTH)).optional(),
  })
  .transform((flags) => ({ passwordStdin: flags[PASSWORD_STDIN_FLAG], user: flags.user }));
export type ResetOptions = z.infer<typeof ResetOptionsSchema>;

/** `setup <client>`: the owner claim's options plus the profile the client's config and sign-in belong to. */
export const SetupOptionsSchema = z
  .object({
    [PASSWORD_STDIN_FLAG]: z.boolean().default(false),
    username: UsernameSchema.optional(),
    profile: ProfileSchema.default(DEFAULT_PROFILE),
  })
  .transform((flags) => ({
    passwordStdin: flags[PASSWORD_STDIN_FLAG],
    username: flags.username,
    profile: flags.profile,
  }));
export type SetupOptions = z.infer<typeof SetupOptionsSchema>;

/** `login`: `profile` falls back to `FINTRACK_PROFILE` (the shell decides); `duration`/`scope` only pre-select the
 *  consent page — the person approving still chooses. */
export const LoginOptionsSchema = z.object({
  profile: ProfileSchema.optional(),
  duration: LoginDuration.optional(),
  scope: TokenAccess.optional(),
});
export type LoginOptions = z.infer<typeof LoginOptionsSchema>;

export const LogoutOptionsSchema = z.object({ profile: ProfileSchema.optional() });
export type LogoutOptions = z.infer<typeof LogoutOptionsSchema>;

export const UsersSubcommand = z.enum(['list', 'invite', 'reissue', 'disable', 'enable', 'role']);
export type UsersSubcommand = z.infer<typeof UsersSubcommand>;

/** How many positionals each `users` subcommand takes: none, one username, or a username and a role. */
export const USERS_POSITIONALS: Readonly<Record<UsersSubcommand, number>> = {
  list: 0,
  invite: 1,
  reissue: 1,
  disable: 1,
  enable: 1,
  role: 2,
};

/** `users invite <username> [--admin]`: members unless `--admin`. */
export const InviteOptionsSchema = z
  .object({ admin: z.boolean().default(false) })
  .transform((flags) => ({ role: flags.admin ? UserRole.enum.admin : UserRole.enum.member }));
export type InviteOptions = z.infer<typeof InviteOptionsSchema>;

/** A username named on the command line is only normalized: an unknown one is a clear "no such user". */
export const TargetUsernameSchema = z
  .string()
  .transform(normalizeUsername)
  .pipe(z.string().min(1).max(OPTION_MAX_LENGTH));
