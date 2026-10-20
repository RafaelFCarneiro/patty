import * as R from 'remeda';
import type { AppError } from '../../common/errors.js';
import { authErrors } from '../../models/auth/errors.js';
import { USER_ENTITY_TAG } from '../../models/auth/entity.js';
import { INVITE_PATH, INVITE_CODE_PARAM } from '../../models/auth/origin.js';
import { type UserEntity, UserRole } from '../../models/auth/owner.js';
import { PrincipalVia } from '../../models/auth/principal.js';
import {
  ActorKind,
  AdminChange,
  INVITE_TTL_MS,
  type Actor,
  type InviteEntity,
  UserStatus,
  type UserSummary,
} from '../../models/auth/users.js';
import { hasCredentials, isActiveUser, formatSetupCode, normalizeSetupCode } from './owner.js';
import { millis, toIso } from './time.js';
import * as persistence from '../persistence.js';
import type { Persistable } from '@rfc0/effect-runner';
import { CHANGE_BLOCKS_SELF } from '../../models/auth/users.js';

export const normalizeInviteCode = normalizeSetupCode;
export const formatInviteCode = formatSetupCode;

export const inviteLink = (origin: string, code: string): string =>
  `${origin}${INVITE_PATH}?${INVITE_CODE_PARAM}=${encodeURIComponent(code)}`;

export const userStatus = (user: UserEntity): UserStatus =>
  user.disabledAt !== null
    ? UserStatus.enum.disabled
    : hasCredentials(user)
      ? UserStatus.enum.active
      : UserStatus.enum.invited;

export const isActiveAdmin = (user: UserEntity | null): boolean =>
  isActiveUser(user) && user.role === UserRole.enum.admin;

export const isInviteLive = (invite: InviteEntity, now: Date): boolean =>
  invite.usedAt === null && millis(invite.expiresAt) > now.getTime();

export const isInviteUsable = (invite: InviteEntity | null, now: Date): invite is InviteEntity =>
  invite !== null && isInviteLive(invite, now);

export const summarizeUser = (user: UserEntity, invites: readonly InviteEntity[], now: Date): UserSummary => ({
  id: user.id,
  username: user.username,
  role: user.role,
  status: userStatus(user),
  createdAt: user.createdAt,
  lastLoginAt: user.lastLoginAt,
  inviteExpiresAt:
    R.find(invites, (invite) => invite.userId === user.id && isInviteLive(invite, now))?.expiresAt ?? null,
});

export const newInvitedUser = (
  fields: { id: string; username: string; role: UserRole },
  now: Date,
): Omit<UserEntity, 'version'> => ({
  id: fields.id,
  username: fields.username,
  passwordHash: null,
  role: fields.role,
  createdAt: now.toISOString(),
  disabledAt: null,
  lastLoginAt: null,
  credentialsChangedAt: now.toISOString(),
});

export const newInvite = (
  fields: { id: string; userId: string; codeHash: string; createdBy: string | null },
  now: Date,
): Omit<InviteEntity, 'version'> => ({
  ...fields,
  createdAt: now.toISOString(),
  expiresAt: toIso(now.getTime() + INVITE_TTL_MS),
  usedAt: null,
});

export const spentInvite = (invite: InviteEntity, now: Date): InviteEntity => ({
  ...invite,
  usedAt: now.toISOString(),
});

export const withCredentialsChanged = (user: UserEntity, now: Date): UserEntity => ({
  ...user,
  credentialsChangedAt: now.toISOString(),
});

export const disabledUser = (user: UserEntity, now: Date): UserEntity =>
  withCredentialsChanged({ ...user, disabledAt: now.toISOString() }, now);
export const enabledUser = (user: UserEntity): UserEntity => ({ ...user, disabledAt: null });
export const withRole = (user: UserEntity, role: UserRole): UserEntity => ({ ...user, role });
export const withoutPassword = (user: UserEntity, now: Date): UserEntity =>
  withCredentialsChanged({ ...user, passwordHash: null }, now);

export const loggedIn = (user: UserEntity, now: Date): UserEntity =>
  withCredentialsChanged({ ...user, lastLoginAt: now.toISOString() }, now);
export const claimedByInvite = (user: UserEntity, passwordHash: string, now: Date): UserEntity => ({
  ...loggedIn(user, now),
  passwordHash,
});

export const authorizeActor = (actor: Actor, acting: UserEntity | null): AppError | null => {
  if (actor.kind === ActorKind.enum.terminal) return null;
  if (actor.principal.via !== PrincipalVia.enum.session) return authErrors.sessionRequired;
  return isActiveAdmin(acting) ? null : authErrors.adminRequired;
};

export const remainingAdmins = (users: readonly UserEntity[], target: UserEntity): UserEntity[] =>
  R.filter(users, (user) => user.id !== target.id && isActiveAdmin(user));

export const guardAdminChange = (
  change: AdminChange,
  fields: { actingUserId: string | null; target: UserEntity; users: readonly UserEntity[] },
): AppError | null => {
  if (CHANGE_BLOCKS_SELF[change] && fields.actingUserId === fields.target.id) return authErrors.cannotChangeSelf;
  const reduces = isActiveAdmin(fields.target);
  return reduces && remainingAdmins(fields.users, fields.target).length === 0 ? authErrors.lastAdmin : null;
};

export const checkUser = (user: UserEntity): Persistable =>
  persistence.check({ entity: USER_ENTITY_TAG, id: user.id, version: user.version });
