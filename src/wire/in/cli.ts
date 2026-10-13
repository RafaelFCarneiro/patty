import { z } from 'zod';
import { PASSWORD_STDIN_FLAG } from '../../common/cli.js';
import {
  DEFAULT_PROFILE,
  LoginDuration,
  normalizeUsername,
  ProfileSchema,
  TokenAccess,
  UsernameSchema,
} from '../../models/auth.js';

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
