import { z } from 'zod';

/** Whether the HTTP surface demands a session. `disabled` is an explicit, loopback-only opt-out. */
export const AuthMode = z.enum(['required', 'disabled']);
export type AuthMode = z.infer<typeof AuthMode>;
/** What `FINTRACK_AUTH` means when unset — on every surface, loopback included. */
export const DEFAULT_AUTH_MODE = AuthMode.enum.required;

/** The environment variable that sets it. */
export const AUTH_ENV_VAR = 'FINTRACK_AUTH';
