import { z } from 'zod';

export const EXIT_OK = 0;
export const EXIT_FAILURE = 1;

export const PASSWORD_STDIN_FLAG = 'password-stdin';

/** How many positional arguments each command takes: `setup` names one client, the `auth` subcommands none. */
export const SETUP_POSITIONALS = 1;
export const AUTH_POSITIONALS = 0;

export const CliCommand = z.enum(['setup', 'auth']);
export type CliCommand = z.infer<typeof CliCommand>;

export const AuthSubcommand = z.enum(['setup', 'reset-password']);
export type AuthSubcommand = z.infer<typeof AuthSubcommand>;
