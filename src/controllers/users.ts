import { INITIAL_VERSION, type FlowOutcome, type Persistable } from '@rfc0/effect-runner';
import { ok, safeTry, type ResultAsync } from 'neverthrow';
import * as R from 'remeda';
import type { AppError } from '../common/errors.js';
import { guard, okOr, orRefuse } from '../common/result.js';
import { signInCapOf } from '../logic/auth/grant.js';
import { hasCredentials } from '../logic/auth/owner.js';
import { canLogin } from '../logic/auth/password.js';
import { removeSession } from '../logic/auth/revoke.js';
import { planDisable, planReissue, planRole } from '../logic/auth/userPlans.js';
import {
  authorizeActor,
  claimedByInvite,
  enabledUser,
  formatInviteCode,
  isInviteUsable,
  newInvite,
  newInvitedUser,
  normalizeInviteCode,
  spentInvite,
  summarizeUser,
  checkUser,
} from '../logic/auth/users.js';
import { liveSessionOf } from '../logic/auth/session.js';
import * as persistence from '../logic/persistence.js';
import {
  ACCESS_TOKEN_ENTITY_TAG,
  CLIENT_GRANT_ENTITY_TAG,
  INSTANCE_SETTINGS_ENTITY_TAG,
  INVITE_ENTITY_TAG,
  SESSION_ENTITY_TAG,
  USER_ENTITY_TAG,
} from '../models/auth/entity.js';
import { authErrors } from '../models/auth/errors.js';
import type { UserEntity } from '../models/auth/owner.js';
import type { StartedSession } from '../models/auth/session.js';
import {
  ActorKind,
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
import { UserPlan, UserChange, Admitted } from '../models/auth/users.js';
import { NO_REVOCATIONS } from '../models/auth/users.js';


const updateUser = (user: UserEntity): Persistable => persistence.update({ entity: USER_ENTITY_TAG, model: user });

const removeInvite = (invite: InviteEntity): Persistable =>
  persistence.remove({ entity: INVITE_ENTITY_TAG, id: invite.id, version: invite.version });

const persistOf = (plan: UserPlan): Persistable[] => [
  ...R.map(plan.checks, checkUser),
  ...R.map(plan.removedInvites, removeInvite),
  ...R.map(plan.newInvites, (invite) => persistence.insert({ entity: INVITE_ENTITY_TAG, model: invite })),
  ...R.map(plan.userWrites, updateUser),
  ...R.map(plan.expiredGrants, (grant) => persistence.update({ entity: CLIENT_GRANT_ENTITY_TAG, model: grant })),
  ...R.map(plan.sessions, removeSession),
  ...R.map(plan.tokens, (token) => persistence.update({ entity: ACCESS_TOKEN_ENTITY_TAG, model: token })),
];

const stepUpMatches = async (deps: AuthDeps, acting: UserEntity | null, password: string | undefined) =>
  canLogin(
    acting,
    await deps.secrets.verifyPassword(acting?.passwordHash ?? deps.secrets.dummyPasswordHash, password ?? ''),
  );

const admit = (deps: AuthDeps, actor: Actor, options: { stepUp: boolean }): ResultAsync<Admitted, AppError> =>
  safeTry(async function* () {
    const acting = actor.kind === ActorKind.enum.session ? await deps.users.findById(actor.principal.userId) : null;
    yield* orRefuse(authorizeActor(actor, acting));
    if (actor.kind !== ActorKind.enum.session) return ok({ actingUserId: null, acting: null, session: null });
    const sessions = await deps.sessions.listByUser(actor.principal.userId);
    const session = yield* okOr(
      liveSessionOf(sessions, actor.principal.sessionId, deps.clock()),
      authErrors.unauthenticated,
    );
    if (options.stepUp) yield* guard(await stepUpMatches(deps, acting, actor.password), authErrors.invalidCredentials);
    return ok({ actingUserId: acting?.id ?? null, acting, session });
  });

const sessionCheck = ({ session }: Admitted): Persistable[] =>
  session === null ? [] : [persistence.check({ entity: SESSION_ENTITY_TAG, id: session.id, version: session.version })];

const batchOf = (admitted: Admitted, plan: UserPlan): Persistable[] => {
  const writes = persistOf(plan);
  return writes.length === 0 ? [] : [...sessionCheck(admitted), ...writes];
};

const actorCheck = (admitted: Admitted): Persistable[] => [
  ...(admitted.acting === null ? [] : [checkUser(admitted.acting)]),
  ...sessionCheck(admitted),
];

const targetOf = ({ acting }: Admitted, deps: AuthDeps, userId: string): ResultAsync<UserEntity, AppError> =>
  safeTry(async function* () {
    if (acting !== null && acting.id === userId) return ok(acting);
    return ok(yield* okOr(await deps.users.findById(userId), authErrors.unknownUser(userId)));
  });

export const resolveUserId = (deps: AuthDeps, username: string): ResultAsync<string, AppError> =>
  safeTry(async function* () {
    const user = yield* okOr(await deps.users.findByUsername(username), authErrors.unknownUser(username));
    return ok(user.id);
  });

const heldCredentials = async (deps: AuthDeps, userId: string) => ({
  sessions: await deps.sessions.listByUser(userId),
  tokens: await deps.accessTokens.listByUser(userId),
  approvedGrants: await deps.clientGrants.listApprovedByUser(userId),
});

export const listUsers = (deps: AuthDeps, actor: Actor): ResultAsync<UserSummary[], AppError> =>
  safeTry(async function* () {
    yield* admit(deps, actor, { stepUp: false });
    const [users, invites] = [await deps.users.listAll(), await deps.invites.listUnclaimed()];
    return ok(R.map(users, (user) => summarizeUser(user, invites, deps.clock())));
  });

const freshInvite = (deps: AuthDeps, fields: { userId: string; createdBy: string | null }, now: Date) => {
  const code = formatInviteCode(deps.secrets.randomInviteCode());
  const invite = newInvite(
    { id: deps.newId(), ...fields, codeHash: deps.secrets.hashSecret(normalizeInviteCode(code)) },
    now,
  );
  return { code, invite, insert: persistence.insert({ entity: INVITE_ENTITY_TAG, model: invite }) };
};

export const inviteUser = (
  deps: AuthDeps,
  actor: Actor,
  input: InviteUserInput,
): ResultAsync<FlowOutcome<IssuedInvite>, AppError> =>
  safeTry(async function* () {
    const admitted = yield* admit(deps, actor, { stepUp: true });
    yield* guard((await deps.users.findByUsername(input.username)) === null, authErrors.usernameTaken(input.username));

    const now = deps.clock();
    const user = newInvitedUser({ id: deps.newId(), ...input }, now);
    const invite = freshInvite(deps, { userId: user.id, createdBy: admitted.actingUserId }, now);
    const summary = {
      ...summarizeUser({ ...user, version: INITIAL_VERSION }, [], now),
      inviteExpiresAt: invite.invite.expiresAt,
    };
    return ok({
      persist: [...actorCheck(admitted), persistence.insert({ entity: USER_ENTITY_TAG, model: user }), invite.insert],
      response: { user: summary, code: invite.code, expiresAt: invite.invite.expiresAt, revoked: NO_REVOCATIONS },
    });
  });

export const reissueInvite = (
  deps: AuthDeps,
  actor: Actor,
  userId: string,
): ResultAsync<FlowOutcome<IssuedInvite>, AppError> =>
  safeTry(async function* () {
    const admitted = yield* admit(deps, actor, { stepUp: true });
    const target = yield* targetOf(admitted, deps, userId);
    const now = deps.clock();
    const invite = freshInvite(deps, { userId: target.id, createdBy: admitted.actingUserId }, now);
    const plan = yield* planReissue({
      ...admitted,
      target,
      users: await deps.users.listAll(),
      held: await heldCredentials(deps, target.id),
      openInvites: await deps.invites.listUnclaimedByUser(target.id),
      invite: invite.invite,
      now,
    });
    const user = { ...summarizeUser(plan.after, [], now), inviteExpiresAt: invite.invite.expiresAt };
    const response = { user, code: invite.code, expiresAt: invite.invite.expiresAt, revoked: plan.revoked };
    return ok({ persist: batchOf(admitted, plan), response });
  });

const isClaimable = (user: UserEntity | null): user is UserEntity =>
  user !== null && user.disabledAt === null && !hasCredentials(user);

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

export const disableUser = (
  deps: AuthDeps,
  actor: Actor,
  userId: string,
): ResultAsync<FlowOutcome<UserChange>, AppError> =>
  safeTry(async function* () {
    const admitted = yield* admit(deps, actor, { stepUp: true });
    const target = yield* targetOf(admitted, deps, userId);
    const now = deps.clock();
    const plan = yield* planDisable({
      ...admitted,
      target,
      users: await deps.users.listAll(),
      held: await heldCredentials(deps, target.id),
      openInvites: await deps.invites.listUnclaimedByUser(target.id),
      now,
    });
    return ok({
      persist: batchOf(admitted, plan),
      response: reportOf(plan.after, plan.revoked, now),
    });
  });

export const enableUser = (
  deps: AuthDeps,
  actor: Actor,
  userId: string,
): ResultAsync<FlowOutcome<UserChange>, AppError> =>
  safeTry(async function* () {
    const admitted = yield* admit(deps, actor, { stepUp: true });
    const target = yield* targetOf(admitted, deps, userId);
    const now = deps.clock();
    if (target.disabledAt === null) return ok({ persist: [], response: reportOf(target, NO_REVOCATIONS, now) });
    const enabled = enabledUser(target);
    return ok({
      persist: [...actorCheck(admitted), updateUser(enabled)],
      response: reportOf(enabled, NO_REVOCATIONS, now),
    });
  });

export const setRole = (
  deps: AuthDeps,
  actor: Actor,
  input: SetRoleInput,
): ResultAsync<FlowOutcome<UserChange>, AppError> =>
  safeTry(async function* () {
    const admitted = yield* admit(deps, actor, { stepUp: true });
    const target = yield* targetOf(admitted, deps, input.userId);
    const now = deps.clock();
    const plan = yield* planRole({ ...admitted, target, users: await deps.users.listAll(), role: input.role, now });
    return ok({
      persist: batchOf(admitted, plan),
      response: reportOf(plan.after, plan.revoked, now),
    });
  });

export const setSignInCap = (
  deps: AuthDeps,
  actor: Actor,
  input: SetSignInCapInput,
): ResultAsync<FlowOutcome<SignInCap>, AppError> =>
  safeTry(async function* () {
    const admitted = yield* admit(deps, actor, { stepUp: true });
    const current = await deps.instanceSettings.get();
    if (signInCapOf(current) === input.maxSignInDuration) return ok({ persist: [], response: input.maxSignInDuration });
    const write = persistence.update({
      entity: INSTANCE_SETTINGS_ENTITY_TAG,
      model: { ...current, maxSignInDuration: input.maxSignInDuration },
    });
    return ok({ persist: [...actorCheck(admitted), write], response: input.maxSignInDuration });
  });

export const pruneExpiredInvites = (deps: AuthDeps): ResultAsync<FlowOutcome<number>, AppError> =>
  safeTry(async function* () {
    const expired = await deps.invites.listExpiredUnclaimed(deps.clock().toISOString());
    return ok({ persist: R.map(expired, removeInvite), response: expired.length });
  });

export const currentSignInCap = async (deps: AuthDeps): Promise<SignInCap> =>
  signInCapOf(await deps.instanceSettings.get());
