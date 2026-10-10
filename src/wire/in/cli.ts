import { z } from 'zod';
import { normalizeUsername, UsernameSchema } from '../../models/auth.js';

const OPTION_MAX_LENGTH = 256;

/** The flags `fintrack setup` and `fintrack auth setup` accept (as `util.parseArgs` hands them over). */
export const ClaimOptionsSchema = z
  .object({
    'password-stdin': z.boolean().default(false),
    username: UsernameSchema.optional(),
  })
  .transform((flags) => ({ passwordStdin: flags['password-stdin'], username: flags.username }));
export type ClaimOptions = z.infer<typeof ClaimOptionsSchema>;

/** The flags `fintrack auth reset-password` accepts. `--user` only needs normalizing: an unknown name is a
 *  clear "no such user", not a validation failure. */
export const ResetOptionsSchema = z
  .object({
    'password-stdin': z.boolean().default(false),
    user: z.string().min(1).max(OPTION_MAX_LENGTH).transform(normalizeUsername).optional(),
  })
  .transform((flags) => ({ passwordStdin: flags['password-stdin'], user: flags.user }));
export type ResetOptions = z.infer<typeof ResetOptionsSchema>;
