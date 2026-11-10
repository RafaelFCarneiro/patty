import { err, ok, safeTry, ResultAsync } from 'neverthrow';
import { findUserNamed, hasClaimedAdmin, mayExportKey } from '../../logic/auth/key-export.js';
import { authErrors } from '../../models/auth/errors.js';
import { usersUnreadable, type AdminCredentials, type KeyExportError } from '../../models/auth/key-export.js';
import type { UserEntity } from '../../models/auth/owner.js';
import type { KeyExportDeps } from '../deps.js';
import { confirmedUser } from './step-up.js';

const readUsers = (deps: Pick<KeyExportDeps, 'users'>): ResultAsync<UserEntity[], KeyExportError> =>
  new ResultAsync(deps.users()).mapErr(usersUnreadable);

/** Before anything is asked: an administrator with a login must exist, or there is no password to check. */
export const guardClaimedAdminExists = (deps: Pick<KeyExportDeps, 'users'>): ResultAsync<void, KeyExportError> =>
  safeTry(async function* () {
    const users = yield* readUsers(deps);
    return hasClaimedAdmin(users) ? ok(undefined) : err(authErrors.ownerUnclaimed);
  });

/**
 * Step-up for the key export: the administrator whose password this is. Unknown user, wrong password, a member and a
 * disabled user are the same refusal, and each costs one full password check.
 */
export const confirmKeyExportAdmin = (
  deps: KeyExportDeps,
  credentials: AdminCredentials,
): ResultAsync<UserEntity, KeyExportError> =>
  safeTry(async function* () {
    const users = yield* readUsers(deps);
    const confirmed = await confirmedUser(deps, findUserNamed(users, credentials.username), credentials.password);
    return mayExportKey(confirmed) ? ok(confirmed) : err(authErrors.invalidCredentials);
  });
