import { z } from 'zod';

export const EXIT_OK = 0;
export const EXIT_FAILURE = 1;

/** The flag that takes the password from stdin instead of asking for it (scripted installs). */
export const PASSWORD_STDIN_FLAG = 'password-stdin';

/** The first argument that makes the binary run a command instead of the server. */
export const CliCommand = z.enum(['setup', 'auth']);
export type CliCommand = z.infer<typeof CliCommand>;

/** `fintrack auth <subcommand>`. */
export const AuthSubcommand = z.enum(['setup', 'reset-password']);
export type AuthSubcommand = z.infer<typeof AuthSubcommand>;
