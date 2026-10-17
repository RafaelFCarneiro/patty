import { INITIAL_VERSION, type FlowOutcome, type Persistable } from '@rfc0/effect-runner';
import { ok, safeTry, type ResultAsync } from 'neverthrow';
import * as R from 'remeda';
import type { AppError } from '../common/errors.js';
import { guard, okOr, orRefuse } from '../common/result.js';
import { signInCapOf } from '../logic/auth/grant.js';
import { hasCredentials } from '../logic/auth/owner.js';
import { canLogin } from '../logic/auth/password.js';
import { endingCredentials } from '../logic/auth/revoke.js';
import {
  authorizeActor,
  claimedByInvite,
  disabledUser,
  enabledUser,
  formatInviteCode,
  guardAdminChange,
  isActiveAdmin,
  isInviteUsable,
  newInvite,
  newInvitedUser,
  normalizeInviteCode,
  remainingAdmins,
  spentInvite,
  summarizeUser,
  withoutPassword,
  withRole,
  type AdminChange,
} from '../logic/auth/users.js';
import * as persistence from '../logic/persistence.js';
import { INSTANCE_SETTINGS_ENTITY_TAG, INVITE_ENTITY_TAG, USER_ENTITY_TAG } from '../models/auth/entity.js';
import { authErrors } from '../models/auth/errors.js';
import { type UserEntity, UserRole } from '../models/auth/owner.js';
import type { StartedSession } from '../models/auth/session.js';
import {
  INSTANCE_SETTINGS_ID,
  type Actor,
  type ClaimInviteInput,
  type InviteEntity,
  type InviteUserInput,
  type IssuedInvite,
  type RevokedCredentials,
  type SetRoleInput,
  type SetSignInCapInput,
  type SignInCap,
  type UserSummary,
} from '../models/auth/users.js';
import { startSession } from './auth.js';
import type { AuthDeps } from './deps.js';

/**
 * User management (ADR-033 §2, §5). Every flow is the same sandwich: gather (who is asking, the users, their
 * credentials) → decide (`logic/auth/users.ts`: the guard tables) → persist (one batch, so a disable ends every
 * credential in the same write that disables). The actor is a browser admin session (user management is never
 * reachable by a token or over MCP) or the trusted terminal.
 */

const NO_REVOCATIONS: RevokedCredentials = { sessionsEnded: 0, tokensRevoked: 0 };

/** What an action did to a user, for the report to whoever asked. */
export type UserChange = { user: UserSummary; revoked: RevokedCredentials };

const updateUser = (user: UserEntity): Persistable => persistence.update({ entity: USER_ENTITY_TAG, model: user });

/**
 * Re-writes the admins an action leaves standing, unchanged, so that their `version` is part of the decision. Two
 * admins disabling each other at once each read "the other is still an admin"; with these writes the second commit
 * finds a stale version, retries, sees the first one's effect and is refused — the instance never ends up with none.
 */
const witnessingAdmins = (users: readonly UserEntity[], target: UserEntity): Persistable[] =>
  R.map(remainingAdmins(users, target), updateUser);

const removeInvite = (invite: InviteEntity): Persistable =>
  persistence.remove({ entity: INVITE_ENTITY_TAG, id: invite.id, version: invite.version });

/** Re-types the password as proof it is the admin and not a script running in their browser (like token creation). */
const stepUpMatches = async (deps: AuthDeps, acting: UserEntity | null, password: string | undefined) =>
  canLogin(
    acting,
    await deps.secrets.verifyPassword(acting?.passwordHash ?? deps.secrets.dummyPasswordHash, password ?? ''),
  );

/**
 * The gate every flow passes first: session-only and admin-only (the browser admin), or the trusted terminal. `stepUp`
 * flows also re-ask the admin's password; the terminal has none. Answers who is acting (`null` = the terminal).
 */
const admit = (deps: AuthDeps, actor: Actor, options: { stepUp: boolean }): ResultAsync<string | null, AppError> =>
  safeTry(async function* () {
    const acting = actor.kind === 'session' ? await deps.users.findById(actor.principal.userId) : null;
    yield* orRefuse(authorizeActor(actor, acting));
    if (actor.kind === 'session' && options.stepUp) {
      yield* guard(await stepUpMatches(deps, acting, actor.password), authErrors.invalidCredentials);
    }
    return ok(actor.kind === 'session' ? actor.principal.userId : null);
  });

const targetOf = (deps: AuthDeps, userId: string): ResultAsync<UserEntity, AppError> =>
  safeTry(async function* () {
    return ok(yield* okOr(await deps.users.findById(userId), authErrors.unknownUser(userId)));
  });

/** The terminal names users by username; the browser by id. */
export const resolveUserId = (deps: AuthDeps, username: string): ResultAsync<string, AppError> =>
  safeTry(async function* () {
    const user = yield* okOr(await deps.users.findByUsername(username), authErrors.unknownUser(username));
    return ok(user.id);
  });

const heldCredentials = async (deps: AuthDeps, userId: string) => ({
  sessions: await deps.sessions.listByUser(userId),
  tokens: await deps.accessTokens.listByUser(userId),
});

/** Admins, members and invited people alike, oldest first, with where each stands. */
export const listUsers = (deps: AuthDeps, actor: Actor): ResultAsync<UserSummary[], AppError> =>
  safeTry(async function* () {
    yield* admit(deps, actor, { stepUp: false });
    const [users, invites] = [await deps.users.listAll(), await deps.invites.listUnclaimed()];
    return ok(R.map(users, (user) => summarizeUser(user, invites, deps.clock())));
  });

/** A new code and the invite that stores its hash. The plaintext goes to the caller once and nowhere else. */
const freshInvite = (deps: AuthDeps, fields: { userId: string; createdBy: string | null }, now: Date) => {
  const code = formatInviteCode(deps.secrets.randomInviteCode());
  const invite = newInvite(
    { id: deps.newId(), ...fields, codeHash: deps.secrets.hashSecret(normalizeInviteCode(code)) },
    now,
  );
  return { code, invite, insert: persistence.insert({ entity: INVITE_ENTITY_TAG, model: invite }) };
};

/**
 * The one flow that creates a user: an unclaimed row (username + role, no password) with its invite. The person sets
 * their own password by claiming the invite; the admin never learns it.
 */
export const inviteUser = (
  deps: AuthDeps,
  actor: Actor,
  input: InviteUserInput,
): ResultAsync<FlowOutcome<IssuedInvite>, AppError> =>
  safeTry(async function* () {
    const actingUserId = yield* admit(deps, actor, { stepUp: true });
    yield* guard((await deps.users.findByUsername(input.username)) === null, authErrors.usernameTaken(input.username));

    const now = deps.clock();
    const user = newInvitedUser({ id: deps.newId(), ...input }, now);
    const invite = freshInvite(deps, { userId: user.id, createdBy: actingUserId }, now);
    const summary = {
      ...summarizeUser({ ...user, version: INITIAL_VERSION }, [], now),
      inviteExpiresAt: invite.invite.expiresAt,
    };
    return ok({
      persist: [persistence.insert({ entity: USER_ENTITY_TAG, model: user }), invite.insert],
      response: { user: summary, code: invite.code, expiresAt: invite.invite.expiresAt, revoked: NO_REVOCATIONS },
    });
  });

/**
 * A new invite for a user who has not claimed one, or an admin-driven password reset for one who has. The previous
 * unclaimed invite is removed in the same batch. A claimed user also loses their password and every session, token
 * and stdio sign-in, so the new invite is the only way back in.
 */
export const reissueInvite = (
  deps: AuthDeps,
  actor: Actor,
  userId: string,
): ResultAsync<FlowOutcome<IssuedInvite>, AppError> =>
  safeTry(async function* () {
    const actingUserId = yield* admit(deps, actor, { stepUp: true });
    const target = yield* targetOf(deps, userId);
    yield* guard(target.disabledAt === null, authErrors.userDisabled);
    const users = await deps.users.listAll();
    yield* orRefuse(guardAdminChange('reissue', { actingUserId, target, users }));

    const now = deps.clock();
    const claimed = hasCredentials(target);
    const ended = claimed ? endingCredentials(await heldCredentials(deps, target.id), now) : null;
    const invite = freshInvite(deps, { userId: target.id, createdBy: actingUserId }, now);
    const replaced = R.map(await deps.invites.listUnclaimedByUser(target.id), removeInvite);
    const persist: Persistable[] = [
      ...replaced,
      invite.insert,
      ...(claimed ? [updateUser(withoutPassword(target))] : []),
      ...(ended?.persist ?? []),
      ...(isActiveAdmin(target) ? witnessingAdmins(users, target) : []),
    ];
    const summary = { ...summarizeUser(withoutPassword(target), [], now), inviteExpiresAt: invite.invite.expiresAt };
    return ok({
      persist,
      response: {
        user: summary,
        code: invite.code,
        expiresAt: invite.invite.expiresAt,
        revoked: ended?.revoked ?? NO_REVOCATIONS,
      },
    });
  });

/** An invite is claimable only by the unclaimed, enabled user it was issued for. */
const isClaimable = (user: UserEntity | null): user is UserEntity =>
  user !== null && user.disabledAt === null && !hasCredentials(user);

/**
 * The invited person chooses their password: the invite is spent, the existing unclaimed row is UPDATED (never
 * inserted) and a session starts, so they land signed in. Single-use: a second claim — or a concurrent one that loses
 * the version race and retries — finds the invite spent. Wrong, expired, used, disabled and foreign invites read the
 * same.
 */
export const claimInvite = (
  deps: AuthDeps,
  input: ClaimInviteInput,
): ResultAsync<FlowOutcome<StartedSession>, AppError> =>
  safeTry(async function* () {
    const now = deps.clock();
    const stored = await deps.invites.findByHash(deps.secrets.hashSecret(normalizeInviteCode(input.code)));
    const invite = yield* okOr(isInviteUsable(stored, now) ? stored : null, authErrors.invalidInvite);
    const user = yield* okOr(await claimableUser(deps, invite), authErrors.invalidInvite);

    const passwordHash = await deps.secrets.hashPassword(input.password);
    const { persistable: sessionInsert, started } = startSession(deps, user.id, now);
    const persist: Persistable[] = [
      updateUser(claimedByInvite(user, passwordHash, now)),
      persistence.update({ entity: INVITE_ENTITY_TAG, model: spentInvite(invite, now) }),
      sessionInsert,
    ];
    return ok({ persist, response: started });
  });

const claimableUser = async (deps: AuthDeps, invite: InviteEntity): Promise<UserEntity | null> => {
  const user = await deps.users.findById(invite.userId);
  return isClaimable(user) ? user : null;
};

const reportOf = (user: UserEntity, revoked: RevokedCredentials, now: Date): UserChange => ({
  user: summarizeUser(user, [], now),
  revoked,
});

/**
 * Disabling ends everything the user holds in the same batch that disables them: sessions deleted, personal access
 * tokens and stdio sign-ins revoked. Nothing is deleted from `users` — their rows stay theirs.
 */
export const disableUser = (
  deps: AuthDeps,
  actor: Actor,
  userId: string,
): ResultAsync<FlowOutcome<UserChange>, AppError> =>
  safeTry(async function* () {
    const actingUserId = yield* admit(deps, actor, { stepUp: true });
    const target = yield* targetOf(deps, userId);
    const now = deps.clock();
    if (target.disabledAt !== null) return ok({ persist: [], response: reportOf(target, NO_REVOCATIONS, now) });

    const users = await deps.users.listAll();
    yield* orRefuse(guardAdminChange('disable', { actingUserId, target, users }));
    const ended = endingCredentials(await heldCredentials(deps, target.id), now);
    const disabled = disabledUser(target, now);
    const witnesses = isActiveAdmin(target) ? witnessingAdmins(users, target) : [];
    return ok({
      persist: [updateUser(disabled), ...ended.persist, ...witnesses],
      response: reportOf(disabled, ended.revoked, now),
    });
  });

/** Enabling restores the ability to log in and nothing else: the sessions and tokens ended at disable stay ended. */
export const enableUser = (
  deps: AuthDeps,
  actor: Actor,
  userId: string,
): ResultAsync<FlowOutcome<UserChange>, AppError> =>
  safeTry(async function* () {
    yield* admit(deps, actor, { stepUp: false });
    const target = yield* targetOf(deps, userId);
    const now = deps.clock();
    if (target.disabledAt === null) return ok({ persist: [], response: reportOf(target, NO_REVOCATIONS, now) });
    const enabled = enabledUser(target);
    return ok({ persist: [updateUser(enabled)], response: reportOf(enabled, NO_REVOCATIONS, now) });
  });

export const setRole = (
  deps: AuthDeps,
  actor: Actor,
  input: SetRoleInput,
): ResultAsync<FlowOutcome<UserChange>, AppError> =>
  safeTry(async function* () {
    const actingUserId = yield* admit(deps, actor, { stepUp: true });
    const target = yield* targetOf(deps, input.userId);
    const now = deps.clock();
    if (target.role === input.role) return ok({ persist: [], response: reportOf(target, NO_REVOCATIONS, now) });

    const users = await deps.users.listAll();
    const change: AdminChange | null = input.role === UserRole.enum.member ? 'demote' : null;
    if (change !== null) yield* orRefuse(guardAdminChange(change, { actingUserId, target, users }));
    const changed = withRole(target, input.role);
    const witnesses = change !== null && isActiveAdmin(target) ? witnessingAdmins(users, target) : [];
    return ok({ persist: [updateUser(changed), ...witnesses], response: reportOf(changed, NO_REVOCATIONS, now) });
  });

/** The instance-wide longest stdio sign-in. It limits future approvals only; granted sign-ins keep their expiry. */
export const setSignInCap = (
  deps: AuthDeps,
  actor: Actor,
  input: SetSignInCapInput,
): ResultAsync<FlowOutcome<SignInCap>, AppError> =>
  safeTry(async function* () {
    yield* admit(deps, actor, { stepUp: true });
    const current = await deps.instanceSettings.get();
    if (signInCapOf(current) === input.maxSignInDuration) return ok({ persist: [], response: input.maxSignInDuration });
    const model = { id: INSTANCE_SETTINGS_ID, maxSignInDuration: input.maxSignInDuration };
    const write = current
      ? persistence.update({ entity: INSTANCE_SETTINGS_ENTITY_TAG, model: { ...model, version: current.version } })
      : persistence.insert({ entity: INSTANCE_SETTINGS_ENTITY_TAG, model });
    return ok({ persist: [write], response: input.maxSignInDuration });
  });

/** The cap as the users page shows it. */
export const currentSignInCap = async (deps: AuthDeps): Promise<SignInCap> =>
  signInCapOf(await deps.instanceSettings.get());
