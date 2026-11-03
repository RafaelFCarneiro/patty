import { z } from 'zod';
import { LoginDuration } from '../../models/auth/grant.js';
import { UserRole } from '../../models/auth/owner.js';
import { UsernameSchema, normalizeUsername } from '../../models/auth/password.js';
import { DEFAULT_PROFILE, ProfileSchema } from '../../models/auth/sign-in.js';
import { TokenAccess } from '../../models/auth/token.js';
import { DemoCountry } from '../../models/demo/core.js';

/** The CLI's argv grammar: the commands, their subcommands, their flags and how many positionals each takes. */
export const PASSWORD_STDIN_FLAG = 'password-stdin';

/** How many positional arguments each command takes: `setup` names one client, the `auth` subcommands none. */
export const SETUP_POSITIONALS = 1;
export const AUTH_POSITIONALS = 0;
/** `login` and `logout` take flags only. */
export const SIGN_IN_POSITIONALS = 0;

export const CliCommand = z.enum(['setup', 'auth', 'login', 'logout', 'users', 'key', 'db', 'demo']);
export type CliCommand = z.infer<typeof CliCommand>;

export const AuthSubcommand = z.enum(['setup', 'reset-password']);
export type AuthSubcommand = z.infer<typeof AuthSubcommand>;

const OPTION_MAX_LENGTH = 256;
const PATH_MAX_LENGTH = 4096;

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

export const DEMO_FLAG = 'demo';
export const REMOVE_DEMO_FLAG = 'remove-demo';

export const DemoEntryChange = z.enum(['add', 'remove']);
export type DemoEntryChange = z.infer<typeof DemoEntryChange>;

const DEMO_EXCLUSIVE_MESSAGE = `--${DEMO_FLAG} and --${REMOVE_DEMO_FLAG} only edit the client's demo entry: use them alone`;

export const SetupOptionsSchema = z
  .object({
    [PASSWORD_STDIN_FLAG]: z.boolean().default(false),
    username: UsernameSchema.optional(),
    profile: ProfileSchema.optional(),
    [DEMO_FLAG]: z.boolean().default(false),
    [REMOVE_DEMO_FLAG]: z.boolean().default(false),
  })
  .refine(
    (flags) =>
      !(flags[DEMO_FLAG] || flags[REMOVE_DEMO_FLAG]) ||
      (flags[DEMO_FLAG] !== flags[REMOVE_DEMO_FLAG] &&
        !flags[PASSWORD_STDIN_FLAG] &&
        flags.username === undefined &&
        flags.profile === undefined),
    { message: DEMO_EXCLUSIVE_MESSAGE },
  )
  .transform((flags) => ({
    passwordStdin: flags[PASSWORD_STDIN_FLAG],
    username: flags.username,
    profile: flags.profile ?? DEFAULT_PROFILE,
    demo: flags[DEMO_FLAG],
    removeDemo: flags[REMOVE_DEMO_FLAG],
  }));
export type SetupOptions = z.infer<typeof SetupOptionsSchema>;

export const DEMO_POSITIONALS = 0;
export const DemoOptionsSchema = z.object({
  country: z
    .string()
    .refine((value) => DemoCountry.safeParse(value).success, {
      message: `--country must be one of: ${DemoCountry.options.join(', ')}`,
    })
    .pipe(DemoCountry)
    .optional(),
  reset: z.boolean().default(false),
});
export type DemoOptions = z.infer<typeof DemoOptionsSchema>;

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

/** `key export` and `db export`: one subcommand each, no positionals, and the file to write named by `--to`. */
export const KeySubcommand = z.enum(['export']);
export type KeySubcommand = z.infer<typeof KeySubcommand>;
export const DbSubcommand = z.enum(['export']);
export type DbSubcommand = z.infer<typeof DbSubcommand>;
export const EXPORT_POSITIONALS = 0;

export const ExportOptionsSchema = z.object({
  to: z.string({ required_error: 'the destination is required: --to <file>' }).min(1).max(PATH_MAX_LENGTH),
});
export type ExportOptions = z.infer<typeof ExportOptionsSchema>;

/** The flags both export subcommands take, in `parseArgs` form. */
export const EXPORT_FLAGS = { to: { type: 'string' } } as const;
