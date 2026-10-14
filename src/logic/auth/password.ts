import { type UserEntity } from '../../models/auth/owner.js';
import { isActiveUser } from './owner.js';

export const withPasswordHash = (user: UserEntity, passwordHash: string): UserEntity => ({ ...user, passwordHash });

/** Every way a login can fail is the same outcome — the caller cannot tell which. */
export const canLogin = (user: UserEntity | null, passwordMatches: boolean): user is UserEntity =>
  passwordMatches && isActiveUser(user);
