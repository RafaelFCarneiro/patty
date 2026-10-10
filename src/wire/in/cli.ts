import { z } from 'zod';
import { PASSWORD_STDIN_FLAG } from '../../common/cli.js';
import { normalizeUsername, UsernameSchema } from '../../models/auth.js';

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
    user: z.string().min(1).max(OPTION_MAX_LENGTH).transform(normalizeUsername).optional(),
  })
  .transform((flags) => ({ passwordStdin: flags[PASSWORD_STDIN_FLAG], user: flags.user }));
export type ResetOptions = z.infer<typeof ResetOptionsSchema>;
