import * as R from 'remeda';
import type { AppError } from '../../common/errors.js';
import { authErrors } from '../../models/auth/errors.js';
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

/** An invite code is typed and printed exactly like a setup code: case, dashes and spaces never matter. */
export const normalizeInviteCode = normalizeSetupCode;
export const formatInviteCode = formatSetupCode;

/** The link an admin hands the invited person. The code is in the query string on purpose: the page it opens answers
 *  `Referrer-Policy: strict-origin` (no path or query ever leaves) and the logger redacts the parameter; the same
 *  code may be typed instead. */
export const inviteLink = (origin: string, code: string): string =>
  `${origin}${INVITE_PATH}?${INVITE_CODE_PARAM}=${encodeURIComponent(code)}`;

export const userStatus = (user: UserEntity): UserStatus =>
  user.disabledAt !== null
    ? UserStatus.enum.disabled
    : hasCredentials(user)
      ? UserStatus.enum.active
      : UserStatus.enum.invited;

/** Someone who can log in right now AND administers: the only kind the "always one admin" rule counts. */
export const isActiveAdmin = (user: UserEntity | null): boolean =>
  isActiveUser(user) && user.role === UserRole.enum.admin;

export const isInviteLive = (invite: InviteEntity, now: Date): boolean =>
  invite.usedAt === null && millis(invite.expiresAt) > now.getTime();

/** An invite that can be claimed right now: it exists, is unused and unexpired. */
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

export const disabledUser = (user: UserEntity, now: Date): UserEntity => ({ ...user, disabledAt: now.toISOString() });
export const enabledUser = (user: UserEntity): UserEntity => ({ ...user, disabledAt: null });
export const withRole = (user: UserEntity, role: UserRole): UserEntity => ({ ...user, role });
/** The password is gone: the new invite is the only way back in. */
export const withoutPassword = (user: UserEntity): UserEntity => ({ ...user, passwordHash: null });
export const loggedIn = (user: UserEntity, now: Date): UserEntity => ({ ...user, lastLoginAt: now.toISOString() });
/** The invited person chooses their password: the row that exists is updated, never created. */
export const claimedByInvite = (user: UserEntity, passwordHash: string, now: Date): UserEntity => ({
  ...loggedIn(user, now),
  passwordHash,
});

/** Who may manage users: an admin signed in through a browser session — or the trusted terminal. */
export const authorizeActor = (actor: Actor, acting: UserEntity | null): AppError | null => {
  if (actor.kind === ActorKind.enum.terminal) return null;
  if (actor.principal.via !== PrincipalVia.enum.session) return authErrors.sessionRequired;
  return isActiveAdmin(acting) ? null : authErrors.adminRequired;
};

/** Each admin change says whether the acting admin may do it to themself. */
const CHANGE_BLOCKS_SELF: Readonly<Record<AdminChange, boolean>> = {
  [AdminChange.enum.disable]: true,
  [AdminChange.enum.demote]: true,
  // A reissued admin keeps the page that shows them their new invite: locking oneself out is recoverable.
  [AdminChange.enum.reissue]: false,
};

/** Every active admin other than `target` — who is left to administer, and the rows a decision must witness. */
export const remainingAdmins = (users: readonly UserEntity[], target: UserEntity): UserEntity[] =>
  R.filter(users, (user) => user.id !== target.id && isActiveAdmin(user));

/**
 * The guard tables for taking an admin away: nobody disables or demotes themself, and no action leaves zero active
 * admins. `null` = allowed. `actingUserId` is null for the terminal, which acts as nobody.
 */
export const guardAdminChange = (
  change: AdminChange,
  fields: { actingUserId: string | null; target: UserEntity; users: readonly UserEntity[] },
): AppError | null => {
  if (CHANGE_BLOCKS_SELF[change] && fields.actingUserId === fields.target.id) return authErrors.cannotChangeSelf;
  const reduces = isActiveAdmin(fields.target);
  return reduces && remainingAdmins(fields.users, fields.target).length === 0 ? authErrors.lastAdmin : null;
};
