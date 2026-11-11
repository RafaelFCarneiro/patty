import { UserRole, type ClaimedUserEntity, type UserEntity } from '../../models/auth/owner.js';
import { KEY_EXPORT_CONFIRMATION_ANSWER } from '../../models/auth/key-export.js';
import { hasCredentials } from './owner.js';
import { isActiveAdmin } from './users.js';

/** An administrator with a login exists. Until then there is no password to ask for. */
export const hasClaimedAdmin = (users: readonly UserEntity[]): boolean =>
  users.some((user) => user.role === UserRole.enum.admin && hasCredentials(user));

export const findUserNamed = (users: readonly UserEntity[], username: string): UserEntity | null =>
  users.find((user) => user.username === username) ?? null;

/** Only an active administrator with a login may have the key written out. */
export const mayExportKey = (user: UserEntity | null): user is ClaimedUserEntity => isActiveAdmin(user);

export const isExportConfirmation = (answer: string): boolean =>
  answer.trim().toLowerCase() === KEY_EXPORT_CONFIRMATION_ANSWER;
