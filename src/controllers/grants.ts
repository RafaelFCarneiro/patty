import { ok, safeTry, type ResultAsync } from 'neverthrow';
import * as R from 'remeda';
import type { FlowOutcome, Persistable } from '@rfc0/effect-runner';
import type { AppError } from '../common/errors.js';
import { guard, okOr } from '../common/result.js';
import {
  approvedGrant,
  clampToCap,
  consentChoice,
  deniedGrant,
  durationAllowedFor,
  formatUserCode,
  grantRequestOf,
  isAnswerable,
  newGrant,
  newStdioSignIn,
  normalizeUserCode,
  offeredDurations,
  redeemPlan,
  redeemedGrant,
  signInCapOf,
  supersededGrants,
} from '../logic/auth/grant.js';
import { isActiveUser } from '../logic/auth/owner.js';
import { tokenDisplayPrefix, tokenPrincipal } from '../logic/auth/token.js';
import * as persistence from '../logic/persistence.js';
import { ACCESS_TOKEN_ENTITY_TAG, CLIENT_GRANT_ENTITY_TAG, USER_ENTITY_TAG } from '../models/auth/entity.js';
import { authErrors } from '../models/auth/errors.js';
import {
  type ApproveGrantInput,
  type ClientGrantEntity,
  type Consent,
  RedeemKind,
  RedeemPlanKind,
  type RedeemResult,
  type StartGrantInput,
  type StartedGrant,
  USER_CODE_ATTEMPTS,
} from '../models/auth/grant.js';
import { type Principal, PrincipalVia } from '../models/auth/principal.js';
import { TOKEN_ACCESS_SCOPES } from '../models/auth/token.js';
import { conflict } from '../models/error.js';
import type { AuthDeps } from './deps.js';

const plainResult = (kind: Exclude<RedeemKind, typeof RedeemKind.enum.signed_in>): RedeemResult => ({ kind });

const requireSession = (principal: Principal) =>
  guard(principal.via === PrincipalVia.enum.session, authErrors.sessionRequired);

/** A user code no still-pending grant holds. Bounded, so a (practically impossible) streak of collisions fails
 *  instead of looping. */
const freshUserCode = async (deps: AuthDeps, attemptsLeft = USER_CODE_ATTEMPTS): Promise<string | null> => {
  const code = normalizeUserCode(deps.secrets.randomUserCode());
  if ((await deps.clientGrants.findPendingByUserCode(code)) === null) return code;
  return attemptsLeft > 1 ? freshUserCode(deps, attemptsLeft - 1) : null;
};

/**
 * The asking process (stdio server or `fintrack login`) starts a sign-in (ADR-034 §3.1). The device code is
 * returned once and only its hash is stored; the user code is what the person later confirms in the browser.
 */
export const startGrant = (deps: AuthDeps, input: StartGrantInput): ResultAsync<FlowOutcome<StartedGrant>, AppError> =>
  safeTry(async function* () {
    const userCode = yield* okOr(await freshUserCode(deps), conflict);
    const deviceCode = deps.secrets.randomDeviceCode();
    const grant = newGrant(
      { id: deps.newId(), deviceCodeHash: deps.secrets.hashSecret(deviceCode), userCode, input },
      deps.clock(),
    );
    return ok({
      persist: [persistence.insert({ entity: CLIENT_GRANT_ENTITY_TAG, model: grant })],
      response: { deviceCode, userCode: formatUserCode(userCode), expiresAt: grant.expiresAt },
    });
  });

const instanceCap = async (deps: AuthDeps) => signInCapOf(await deps.instanceSettings.get());

/** What the consent page shows for a code, with the form's pre-selection and the durations it may offer (never above
 *  the instance cap) — `null` for an unknown, expired or already-answered code (indistinguishable on purpose).
 *  Read-only. */
export const findConsent = async (deps: AuthDeps, userId: string, rawUserCode: string): Promise<Consent | null> => {
  const grant = await deps.clientGrants.findPendingByUserCode(normalizeUserCode(rawUserCode));
  if (!isAnswerable(grant, deps.clock())) return null;
  const last = await deps.clientGrants.lastRedeemed(userId, grant.profile, grant.clientName);
  const cap = await instanceCap(deps);
  return {
    request: grantRequestOf(grant),
    choice: consentChoice(grant, last, cap),
    durations: offeredDurations(grant.channel, cap),
  };
};

const answerableGrant = (deps: AuthDeps, rawUserCode: string) =>
  safeTry(async function* () {
    const grant = await deps.clientGrants.findPendingByUserCode(normalizeUserCode(rawUserCode));
    return ok(yield* okOr(isAnswerable(grant, deps.clock()) ? grant : null, authErrors.invalidGrant));
  });

/**
 * Approve a pending sign-in as the signed-in person (ADR-034 §3.4). Browser sessions only — a token cannot approve
 * a grant — and the grant binds to the user who approved it, with the scopes and duration they chose, clamped to the
 * instance's `max_sign_in_duration` (ADR-034 §4). Redemption clamps to the cap in force then as well, so a request
 * approved before the cap fell is still minted within it; a sign-in already minted keeps its expiry.
 */
export const approveGrant = (
  deps: AuthDeps,
  principal: Principal,
  input: ApproveGrantInput,
): ResultAsync<FlowOutcome<void>, AppError> =>
  safeTry(async function* () {
    yield* requireSession(principal);
    const grant = yield* answerableGrant(deps, input.userCode);
    yield* guard(durationAllowedFor(grant.channel, input.duration), authErrors.sessionDurationRefused);
    const duration = clampToCap(input.duration, await instanceCap(deps));
    const approved = approvedGrant(
      grant,
      { userId: principal.userId, scopes: TOKEN_ACCESS_SCOPES[input.access], duration },
      deps.clock(),
    );
    return ok({
      persist: [persistence.update({ entity: CLIENT_GRANT_ENTITY_TAG, model: approved })],
      response: undefined,
    });
  });

export const denyGrant = (
  deps: AuthDeps,
  principal: Principal,
  rawUserCode: string,
): ResultAsync<FlowOutcome<void>, AppError> =>
  safeTry(async function* () {
    yield* requireSession(principal);
    const grant = yield* answerableGrant(deps, rawUserCode);
    return ok({
      persist: [persistence.update({ entity: CLIENT_GRANT_ENTITY_TAG, model: deniedGrant(grant) })],
      response: undefined,
    });
  });

/**
 * The asking process trades its device code for the sign-in (ADR-034 §3.5). Single-use: an approved grant mints one
 * token and becomes `redeemed` in the same write, so a second redeem — or a concurrent one that loses the version
 * race and retries — finds a spent grant. The plaintext token is in the response and nowhere else; only its hash
 * and display prefix are stored.
 */
export const redeemGrant = (deps: AuthDeps, deviceCode: string): ResultAsync<FlowOutcome<RedeemResult>, AppError> =>
  safeTry(async function* () {
    const now = deps.clock();
    const grant = await deps.clientGrants.findByDeviceCodeHash(deps.secrets.hashSecret(deviceCode));
    const plan = redeemPlan(grant, now);
    switch (plan.kind) {
      case RedeemPlanKind.enum.invalid:
      case RedeemPlanKind.enum.pending:
      case RedeemPlanKind.enum.denied:
        return ok({ persist: [], response: plainResult(plan.kind) });
      case RedeemPlanKind.enum.expired:
        return ok({
          persist: plan.settle ? [persistence.update({ entity: CLIENT_GRANT_ENTITY_TAG, model: plan.settle })] : [],
          response: plainResult(plan.kind),
        });
      case RedeemPlanKind.enum.mint: {
        // The approver may have lost their login since: a sign-in is only ever minted for a user who can log in.
        const user = await deps.users.findById(plan.grant.userId);
        if (!isActiveUser(user)) return ok({ persist: [], response: plainResult(RedeemKind.enum.invalid) });

        const token = deps.secrets.randomAccessToken();
        // The cap in force now bounds the sign-in too: one approved before it fell is still minted within it.
        const grant = { ...plan.grant, duration: clampToCap(plan.grant.duration, await instanceCap(deps)) };
        const entity = newStdioSignIn(
          {
            id: deps.newId(),
            tokenHash: deps.secrets.hashSecret(token),
            prefix: tokenDisplayPrefix(token),
            grant,
          },
          now,
        );
        // The approver's row is re-written unchanged so a racing disable or reset conflicts and retries into a refusal.
        const persist: Persistable[] = [
          persistence.update({ entity: USER_ENTITY_TAG, model: user }),
          persistence.insert({ entity: ACCESS_TOKEN_ENTITY_TAG, model: entity }),
          persistence.update({ entity: CLIENT_GRANT_ENTITY_TAG, model: redeemedGrant(plan.grant) }),
        ];
        return ok({
          persist,
          response: {
            kind: RedeemKind.enum.signed_in,
            token,
            tokenId: entity.id,
            scopes: entity.scopes,
            principal: tokenPrincipal(entity, user, PrincipalVia.enum.stdio),
            duration: grant.duration,
            expiresAt: entity.expiresAt,
          },
        });
      }
      default: {
        const _exhaustive: never = plan;
        throw new Error(`unmapped redeem plan: ${JSON.stringify(_exhaustive)}`);
      }
    }
  });

/** Startup housekeeping, like sessions: grants that ran out without being redeemed are deleted, and so are redeemed
 *  ones superseded by a newer approval for the same user, profile and client. The newest redeemed grant per key stays —
 *  it is the consent form's memory of the last choice. A live pending or approved grant is never touched. */
export const pruneExpiredGrants = (deps: AuthDeps): ResultAsync<FlowOutcome<number>, AppError> =>
  safeTry(async function* () {
    const expired = await deps.clientGrants.listExpired(deps.clock().toISOString());
    const superseded = supersededGrants(await deps.clientGrants.listRedeemed());
    const doomed = [...expired, ...superseded];
    return ok({
      persist: R.map(doomed, (grant: ClientGrantEntity) =>
        persistence.remove({ entity: CLIENT_GRANT_ENTITY_TAG, id: grant.id, version: grant.version }),
      ),
      response: doomed.length,
    });
  });
