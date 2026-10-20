import { err, ok, type Result } from 'neverthrow';
import * as R from 'remeda';
import type { AppError } from '../../common/errors.js';
import { authErrors } from '../../models/auth/errors.js';
import { type UserEntity, UserRole } from '../../models/auth/owner.js';
import { AdminChange, type InviteEntity } from '../../models/auth/users.js';
import { hasCredentials, isNeverClaimed } from './owner.js';
import { endedCredentials } from './revoke.js';
import {
  disabledUser,
  guardAdminChange,
  isActiveAdmin,
  remainingAdmins,
  withoutPassword,
  withCredentialsChanged,
  withRole,
} from './users.js';
import { UserPlan, HeldCredentials, UserPlanFacts, NO_REVOCATIONS } from '../../models/auth/users.js';

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

const rosterOf = (facts: UserPlanFacts): UserEntity[] =>
  R.map(facts.users, (user) => (facts.acting !== null && user.id === facts.acting.id ? facts.acting : user));

const standing = (users: readonly UserEntity[], target: UserEntity): UserEntity[] =>
  isActiveAdmin(target) ? remainingAdmins(users, target) : [];

const assertedRows = (facts: UserPlanFacts, roster: readonly UserEntity[]): UserEntity[] =>
  R.pipe(
    [facts.target, ...standing(roster, facts.target), ...(facts.acting === null ? [] : [facts.acting])],
    R.uniqueBy((user) => user.id),
  );

const rowsOf = (facts: UserPlanFacts, roster: readonly UserEntity[], writes: UserEntity[]) => ({
  userWrites: writes,
  checks: R.differenceWith(assertedRows(facts, roster), writes, (user, written) => user.id === written.id),
});

export const planDisable = (
  facts: UserPlanFacts & { held: HeldCredentials; openInvites: readonly InviteEntity[] },
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
    expiredGrants: ended.expiredGrants,
    removedInvites: [...facts.openInvites],
    newInvites: [],
    after: disabled,
    revoked: ended.revoked,
  });
};

export const planReissue = (
  facts: UserPlanFacts & {
    held: HeldCredentials;
    openInvites: readonly InviteEntity[];
    invite: Omit<InviteEntity, 'version'>;
  },
): Result<UserPlan, AppError> => {
  if (facts.target.disabledAt !== null) return err(authErrors.userDisabled);
  if (isNeverClaimed(facts.target)) return err(authErrors.ownerUnclaimed);
  const roster = rosterOf(facts);
  const refusal = guardAdminChange(AdminChange.enum.reissue, { ...facts, users: roster });
  if (refusal !== null) return err(refusal);
  const claimed = hasCredentials(facts.target);
  const after = claimed ? withoutPassword(facts.target, facts.now) : facts.target;
  const ended = claimed
    ? endedCredentials(facts.held, facts.now)
    : { sessions: [], tokens: [], expiredGrants: [], revoked: NO_REVOCATIONS };
  return ok({
    ...rowsOf(facts, roster, [claimed ? after : withCredentialsChanged(after, facts.now)]),
    sessions: ended.sessions,
    tokens: ended.tokens,
    expiredGrants: ended.expiredGrants,
    removedInvites: [...facts.openInvites],
    newInvites: [facts.invite],
    after,
    revoked: ended.revoked,
  });
};

export const planRole = (facts: UserPlanFacts & { role: UserRole }): Result<UserPlan, AppError> => {
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
