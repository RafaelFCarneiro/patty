import { canLogin } from '../logic/auth/password.js';
import type { UserEntity } from '../models/auth/owner.js';
import type { AuthDeps } from './deps.js';

/**
 * Step-up: the user, when `password` is theirs and they can sign in, else null. An absent or unclaimed user is verified
 * against a dummy hash, so every refusal costs the same as a wrong password.
 */
export const confirmedUser = async (
  deps: AuthDeps,
  user: UserEntity | null,
  password: string | undefined,
): Promise<UserEntity | null> =>
  canLogin(
    user,
    await deps.secrets.verifyPassword(user?.passwordHash ?? deps.secrets.dummyPasswordHash, password ?? ''),
  )
    ? user
    : null;
