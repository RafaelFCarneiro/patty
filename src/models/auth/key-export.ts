import type { AuthError } from './errors.js';

/** The pause after a wrong administrator answer before the next prompt: each attempt already costs a full password
 *  check, and this keeps a script driving a terminal from trying faster than a person could. */
export const STEP_UP_RETRY_DELAY_MS = 1000;

/** The one answer that confirms writing the key file; anything else cancels. */
export const KEY_EXPORT_CONFIRMATION_ANSWER = 'yes';

export type AdminCredentials = { username: string; password: string };

/** The database could not be read to check an administrator. Says why; never carries a key or a hash. */
export const USERS_UNREADABLE_CODE = 'users_unreadable';
export type UsersUnreadable = { code: typeof USERS_UNREADABLE_CODE; reason: string };

/** Why the key export is not authorized by an administrator. Unknown user, wrong password, a member and a disabled
 *  user are all the same `invalid_credentials`: the refusal must not say which. */
export type KeyExportError = Extract<AuthError, { code: 'owner_unclaimed' | 'invalid_credentials' }> | UsersUnreadable;

export const usersUnreadable = (reason: string): UsersUnreadable => ({ code: USERS_UNREADABLE_CODE, reason });

/** The person looked at the warning and did not confirm. */
export const EXPORT_DECLINED_CODE = 'export_declined';
export type ExportDeclined = { code: typeof EXPORT_DECLINED_CODE };
export const EXPORT_DECLINED: ExportDeclined = { code: EXPORT_DECLINED_CODE };

export type KeyExportStop = KeyExportError | ExportDeclined;
