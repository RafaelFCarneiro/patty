import { z } from 'zod';

/** The first argument that makes the binary run a command instead of the server. */
export const CliCommand = z.enum(['setup', 'auth']);
export type CliCommand = z.infer<typeof CliCommand>;

/** `fintrack auth <subcommand>`. */
export const AuthSubcommand = z.enum(['setup', 'reset-password']);
export type AuthSubcommand = z.infer<typeof AuthSubcommand>;
