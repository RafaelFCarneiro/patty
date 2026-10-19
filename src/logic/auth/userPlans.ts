import { err, ok, type Result } from 'neverthrow';
import * as R from 'remeda';
import type { AppError } from '../../common/errors.js';
import { authErrors } from '../../models/auth/errors.js';
import { type UserEntity, UserRole } from '../../models/auth/owner.js';
import type { SessionEntity } from '../../models/auth/session.js';
import type { AccessTokenEntity } from '../../models/auth/token.js';
import type { ClientGrantEntity } from '../../models/auth/grant.js';
import { AdminChange, type InviteEntity, type RevokedCredentials } from '../../models/auth/users.js';
import { hasCredentials, isNeverClaimed } from './owner.js';
import { expiredGrant } from './grant.js';
import { endedCredentials, type HeldCredentials } from './revoke.js';
import { disabledUser, guardAdminChange, isActiveAdmin, remainingAdmins, withoutPassword, withRole } from './users.js';

/**
 * What an admin action does to the world, as data: the rows to write, delete and revoke. A controller turns it into
 * `Persistable`s with no further decision. Every list is empty when the action does not touch that kind of row, so
 * assembling the batch is plain concatenation.
 */
export type UserPlan = {
  /** User rows that change. */
  userWrites: UserEntity[];
  /** User rows the decision read and did not change (the acting admin, the admins left standing, an unchanged target):
   *  asserted still at their version, so a concurrent change conflicts and the flow re-runs. */
  checks: UserEntity[];
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
  /** The acting admin as admitted (the row that authorized the request); null for the terminal. */
  acting: UserEntity | null;
  target: UserEntity;
  users: readonly UserEntity[];
  now: Date;
};

const NO_REVOCATIONS: RevokedCredentials = { sessionsEnded: 0, tokensRevoked: 0 };

const unchanged = (target: UserEntity): UserPlan => ({
  userWrites: [],
  checks: [],
  sessions: [],
  tokens: [],
  expiredGrants: [],
  removedInvites: [],
  newInvites: [],
  after: target,
  revoked: NO_REVOCATIONS,
});

/**
 * Everyone, with the acting admin as admitted: the decision and the checks are built from the row that
 * authorized the request, so a change made to the actor after that (a demotion) conflicts on its version.
 */
const rosterOf = (facts: Facts): UserEntity[] =>
  R.map(facts.users, (user) => (facts.acting !== null && user.id === facts.acting.id ? facts.acting : user));

/** The admins an action leaves standing: part of the decision, so their `version` is asserted. */
const standing = (users: readonly UserEntity[], target: UserEntity): UserEntity[] =>
  isActiveAdmin(target) ? remainingAdmins(users, target) : [];

/** The rows an action reads and does not change: the target, the admins left standing and the admitted actor. */
const assertedRows = (facts: Facts, roster: readonly UserEntity[]): UserEntity[] =>
  R.pipe(
    [facts.target, ...standing(roster, facts.target), ...(facts.acting === null ? [] : [facts.acting])],
    R.uniqueBy((user) => user.id),
  );

/** The user writes and checks of an action; a row that is written is not also checked. */
const rowsOf = (facts: Facts, roster: readonly UserEntity[], writes: UserEntity[]) => ({
  userWrites: writes,
  checks: R.differenceWith(assertedRows(facts, roster), writes, (user, written) => user.id === written.id),
});

/** Disabling ends every credential and every pending invite in the same plan that disables. Idempotent. */
export const planDisable = (
  facts: Facts & { held: Held; openInvites: readonly InviteEntity[]; approvedGrants: readonly ClientGrantEntity[] },
): Result<UserPlan, AppError> => {
  if (facts.target.disabledAt !== null) return ok(unchanged(facts.target));
  const roster = rosterOf(facts);
  const refusal = guardAdminChange(AdminChange.enum.disable, { ...facts, users: roster });
  if (refusal !== null) return err(refusal);
  const disabled = disabledUser(facts.target, facts.now);
  const ended = endedCredentials(facts.held, facts.now);
  return ok({
    ...rowsOf(facts, roster, [disabled]),
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
  // An owner nobody has set up has no username to claim into: it stays on the setup path.
  if (isNeverClaimed(facts.target)) return err(authErrors.ownerUnclaimed);
  const roster = rosterOf(facts);
  const refusal = guardAdminChange(AdminChange.enum.reissue, { ...facts, users: roster });
  if (refusal !== null) return err(refusal);
  const claimed = hasCredentials(facts.target);
  const after = claimed ? withoutPassword(facts.target) : facts.target;
  const ended = claimed
    ? endedCredentials(facts.held, facts.now)
    : { sessions: [], tokens: [], revoked: NO_REVOCATIONS };
  return ok({
    // An unclaimed target is checked, not written, so a claim or reissue racing this one conflicts on its version
    // instead of leaving a code that can never work.
    ...rowsOf(facts, roster, claimed ? [after] : []),
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
  const roster = rosterOf(facts);
  const refusal =
    facts.role === UserRole.enum.member ? guardAdminChange(AdminChange.enum.demote, { ...facts, users: roster }) : null;
  if (refusal !== null) return err(refusal);
  const changed = withRole(facts.target, facts.role);
  return ok({
    ...unchanged(changed),
    ...rowsOf(facts, roster, [changed]),
  });
};
