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

/** What a person typed vs. what was printed: case, dashes and spaces never matter. */
export const normalizeSetupCode = (raw: string): string =>
  raw
    .replace(NON_ALPHANUMERIC, '')
    .toUpperCase()
    // Crockford base32 has no I/L/O; people mistype them for 1/1/0.
    .replace(/O/g, '0')
    .replace(/[IL]/g, '1');

/** `ABCDEFGHJKMNPQRSTVWX` → `ABCD-EFGH-JKMN-PQRS-TVWX`, for reading off a log line. */
export const formatSetupCode = (raw: string): string =>
  (raw.match(new RegExp(`.{1,${SETUP_CODE_GROUP_SIZE}}`, 'g')) ?? []).join(SETUP_CODE_GROUP_SEPARATOR);

/** The owner is "claimed" once it can log in; until then it is an owner row nobody can sign in as. */
export const hasCredentials = (user: UserEntity): user is ClaimedUserEntity =>
  user.username !== null && user.passwordHash !== null;

export const isUnclaimed = (owner: UserEntity | null): boolean => owner !== null && !hasCredentials(owner);

/** An owner nobody has ever held a login for. An admin reissue (`reissueInvite`) can later leave an owner without a
 *  password, but that owner has a username and is recovered by an invite — setup, with its one-time code, is only for
 *  the owner of a fresh database. */
export const isNeverClaimed = (owner: UserEntity | null): boolean =>
  owner !== null && owner.username === null && owner.passwordHash === null;

/** A setup code exists only while auth is on AND nobody holds the owner's credentials (ADR-033 §2). */
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

/** A claim refused as `setup_unavailable` lost a race: whoever holds the login now (if anyone) is its winner. */
export const claimRaceWinner = (error: { code: string }, holder: ClaimedOwner | null): ClaimedOwner | null =>
  error.code === authErrors.setupUnavailable.code ? holder : null;

/** A user who holds credentials and has not been disabled — the only kind anything is minted for. */
export const isActiveUser = (user: UserEntity | null): user is ClaimedUserEntity =>
  user !== null && hasCredentials(user) && user.disabledAt === null;
