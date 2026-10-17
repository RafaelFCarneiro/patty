import { err, ok, type Result } from 'neverthrow';
import * as R from 'remeda';
import type { AppError } from '../../common/errors.js';
import { authErrors } from '../../models/auth/errors.js';
import { type UserEntity, UserRole } from '../../models/auth/owner.js';
import type { SessionEntity } from '../../models/auth/session.js';
import type { AccessTokenEntity } from '../../models/auth/token.js';
import type { ClientGrantEntity } from '../../models/auth/grant.js';
import { AdminChange, type InviteEntity, type RevokedCredentials } from '../../models/auth/users.js';
import { hasCredentials } from './owner.js';
import { expiredGrant } from './grant.js';
import { endedCredentials, type HeldCredentials } from './revoke.js';
import { disabledUser, guardAdminChange, isActiveAdmin, remainingAdmins, withoutPassword, withRole } from './users.js';

/**
 * What an admin action does to the world, as data: the rows to write, delete and revoke. A controller turns it into
 * `Persistable`s with no further decision. Every list is empty when the action does not touch that kind of row, so
 * assembling the batch is plain concatenation.
 */
export type UserPlan = {
  /** User rows to write, the changed user first, then the admins left standing (re-written unchanged as witnesses). */
  userWrites: UserEntity[];
  sessions: SessionEntity[];
  /** Live tokens, already revoked. */
  tokens: AccessTokenEntity[];
  /** Approved sign-in requests nobody has redeemed yet, now expired: each could still mint a sign-in as the user. */
  expiredGrants: ClientGrantEntity[];
  /** Unclaimed invites to remove. */
  removedInvites: InviteEntity[];
  /** Invites to insert. */
  newInvites: Omit<InviteEntity, 'version'>[];
  /** The user as they stand after the plan, and what it ended. */
  after: UserEntity;
  revoked: RevokedCredentials;
};

type Held = HeldCredentials;

type Facts = {
  actingUserId: string | null;
  target: UserEntity;
  users: readonly UserEntity[];
  now: Date;
};

const NO_REVOCATIONS: RevokedCredentials = { sessionsEnded: 0, tokensRevoked: 0 };

const unchanged = (target: UserEntity): UserPlan => ({
  userWrites: [],
  sessions: [],
  tokens: [],
  expiredGrants: [],
  removedInvites: [],
  newInvites: [],
  after: target,
  revoked: NO_REVOCATIONS,
});

/** The admins an action leaves standing — written unchanged, so their `version` is part of the decision. */
const witnesses = (users: readonly UserEntity[], target: UserEntity): UserEntity[] =>
  isActiveAdmin(target) ? remainingAdmins(users, target) : [];

/** Disabling ends every credential and every pending invite in the same plan that disables. Idempotent. */
export const planDisable = (
  facts: Facts & { held: Held; openInvites: readonly InviteEntity[]; approvedGrants: readonly ClientGrantEntity[] },
): Result<UserPlan, AppError> => {
  if (facts.target.disabledAt !== null) return ok(unchanged(facts.target));
  const refusal = guardAdminChange(AdminChange.enum.disable, facts);
  if (refusal !== null) return err(refusal);
  const disabled = disabledUser(facts.target, facts.now);
  const ended = endedCredentials(facts.held, facts.now);
  return ok({
    userWrites: [disabled, ...witnesses(facts.users, facts.target)],
    sessions: ended.sessions,
    tokens: ended.tokens,
    expiredGrants: R.map(facts.approvedGrants, expiredGrant),
    removedInvites: [...facts.openInvites],
    newInvites: [],
    after: disabled,
    revoked: ended.revoked,
  });
};

/**
 * A new invite replaces the unclaimed ones. For a user who had claimed, it is also an admin-driven reset: the password
 * is cleared and every credential ends, so the invite is the only way back in. A disabled user must be enabled first.
 */
export const planReissue = (
  facts: Facts & {
    held: Held;
    openInvites: readonly InviteEntity[];
    approvedGrants: readonly ClientGrantEntity[];
    invite: Omit<InviteEntity, 'version'>;
  },
): Result<UserPlan, AppError> => {
  if (facts.target.disabledAt !== null) return err(authErrors.userDisabled);
  const refusal = guardAdminChange(AdminChange.enum.reissue, facts);
  if (refusal !== null) return err(refusal);
  const claimed = hasCredentials(facts.target);
  const after = claimed ? withoutPassword(facts.target) : facts.target;
  const ended = claimed
    ? endedCredentials(facts.held, facts.now)
    : { sessions: [], tokens: [], revoked: NO_REVOCATIONS };
  return ok({
    // The target row is always written (unchanged for an unclaimed user), so a claim or reissue racing this one
    // conflicts on its version instead of leaving a code that can never work.
    userWrites: [after, ...witnesses(facts.users, facts.target)],
    sessions: ended.sessions,
    tokens: ended.tokens,
    expiredGrants: R.map(facts.approvedGrants, expiredGrant),
    removedInvites: [...facts.openInvites],
    newInvites: [facts.invite],
    after,
    revoked: ended.revoked,
  });
};

/** A role change. Demoting an active admin is an admin change; promoting, or a role the user already has, is not. */
export const planRole = (facts: Facts & { role: UserRole }): Result<UserPlan, AppError> => {
  if (facts.target.role === facts.role) return ok(unchanged(facts.target));
  const refusal = facts.role === UserRole.enum.member ? guardAdminChange(AdminChange.enum.demote, facts) : null;
  if (refusal !== null) return err(refusal);
  const changed = withRole(facts.target, facts.role);
  return ok({
    ...unchanged(changed),
    userWrites: [changed, ...witnesses(facts.users, facts.target)],
  });
};
