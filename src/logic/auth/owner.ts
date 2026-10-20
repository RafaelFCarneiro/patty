import { authErrors } from '../../models/auth/errors.js';
import { AuthMode } from '../../models/auth/mode.js';
import {
  NON_ALPHANUMERIC,
  SETUP_CODE_GROUP_SEPARATOR,
  SETUP_CODE_GROUP_SIZE,
  type ClaimPlan,
  type ClaimedOwner,
  type ClaimedUserEntity,
  type SetupCodeEntity,
  type UserEntity,
} from '../../models/auth/owner.js';
import { millis } from './time.js';

export const normalizeSetupCode = (raw: string): string =>
  raw.replace(NON_ALPHANUMERIC, '').toUpperCase().replace(/O/g, '0').replace(/[IL]/g, '1');

export const formatSetupCode = (raw: string): string =>
  (raw.match(new RegExp(`.{1,${SETUP_CODE_GROUP_SIZE}}`, 'g')) ?? []).join(SETUP_CODE_GROUP_SEPARATOR);

export const hasCredentials = (user: UserEntity): user is ClaimedUserEntity =>
  user.username !== null && user.passwordHash !== null;

export const isUnclaimed = (owner: UserEntity | null): boolean => owner !== null && !hasCredentials(owner);

export const isNeverClaimed = (owner: UserEntity | null): boolean =>
  owner !== null && owner.username === null && owner.passwordHash === null;

export const shouldIssueSetupCode = (mode: AuthMode, owner: UserEntity | null): boolean =>
  mode === AuthMode.enum.required && isNeverClaimed(owner);

export const isSetupCodeUsable = (code: SetupCodeEntity | null, now: Date): code is SetupCodeEntity =>
  code !== null && code.usedAt === null && millis(code.expiresAt) > now.getTime();

export const claimedOwner = (owner: UserEntity, fields: { username: string; passwordHash: string }): UserEntity => ({
  ...owner,
  ...fields,
});

export const spentSetupCode = (code: SetupCodeEntity, now: Date): SetupCodeEntity => ({
  ...code,
  usedAt: now.toISOString(),
});

export const planOwnerClaim = (claimed: ClaimedOwner | null): ClaimPlan =>
  claimed === null ? { kind: 'claim' } : { kind: 'skip', username: claimed.username };

export const claimRaceWinner = (error: { code: string }, holder: ClaimedOwner | null): ClaimedOwner | null =>
  error.code === authErrors.setupUnavailable.code ? holder : null;

export const isActiveUser = (user: UserEntity | null): user is ClaimedUserEntity =>
  user !== null && hasCredentials(user) && user.disabledAt === null;
