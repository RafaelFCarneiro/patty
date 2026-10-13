import { ok, type Result } from 'neverthrow';
import type { KeychainFailure } from '../../models/auth/signIn.js';
import { formatAppError } from '../../common/errors.js';
import { authenticateToken, revokeSignInByHash } from '../../controllers/accessTokens.js';
import { ownerNeedsSetup } from '../../controllers/auth.js';
import type {
  AuthDeps,
  RunEffects,
  SignInHooks,
  SignInInterpreter,
  SignInServer,
  SignInStore,
} from '../../controllers/deps.js';
import { redeemGrant, startGrant } from '../../controllers/grants.js';
import { CheckKind, EffectKind, ObservationKind, REDEEM_ERROR_KIND } from '../../models/auth/signInFlow.js';
import type { CheckResult, SignInEffect, SignInObservation } from '../../models/auth/signInFlow.js';
import { nextStep } from '../../logic/auth/signInFlow.js';
import { PrincipalVia } from '../../models/auth/principal.js';

/**
 * The shell side of the sign-in protocol. `logic/auth/signInFlow.ts` decides; this runs the effects it describes with
 * the existing controllers (through `run`), the keychain (`store`) and — for the page a person approves on — either the
 * origin the process can already name or a temporary server it starts on demand. It executes and reports; it never
 * chooses between outcomes, so there is no sign-in rule in this file to test twice.
 */
export type SignInInterpreterOptions = {
  deps: AuthDeps;
  /** Already adapted model→row (`bindAuthRunEffects`). */
  run: RunEffects;
  store: SignInStore;
  /** The origin of a page this process can honestly name for `/ui/connect` — `PUBLIC_URL`, or the sidecar it bound — or
   *  `null`. Asked at use, because the sidecar binds after the interpreter exists. */
  origin: () => string | null;
  /** How to serve `/ui/connect` when `origin()` names nothing: a temporary app of this process, on this database.
   *  Absent when there is no HTTP at all (`FINTRACK_HTTP=false`). */
  startPage?: (() => Promise<SignInServer>) | undefined;
};

const E = EffectKind.enum;
const O = ObservationKind.enum;

export const createSignInInterpreter = (options: SignInInterpreterOptions): SignInInterpreter => {
  const { deps, run, store } = options;
  let temporary: SignInServer | null = null;

  // A temporary page, once started, is the page its pending request was announced at, so it is named first.
  const namedOrigin = (): string | null => temporary?.origin ?? options.origin();

  const servePage = async (): Promise<string | null> => {
    temporary = (await options.startPage?.()) ?? null;
    return temporary?.origin ?? null;
  };

  const closePage = async (): Promise<void> => {
    const server = temporary;
    temporary = null;
    await server?.close().catch(() => undefined);
  };

  // An unreadable keychain is a `KeychainFailure`: whether it counts as "nothing saved" is the protocol's call
  // (`tolerateUnreadable`); when it does not, the failure is reported back as an observation.
  const loadSaved = async (tolerateUnreadable: boolean): Promise<Result<string | null, KeychainFailure>> => {
    const loaded = await store.load();
    return loaded.isErr() && tolerateUnreadable ? ok(null) : loaded;
  };

  const checkResult = async (token: string): Promise<CheckResult> => {
    const result = await run(() => authenticateToken(deps, deps.secrets.hashSecret(token), PrincipalVia.enum.stdio));
    if (result.isErr()) return { kind: CheckKind.enum.failure };
    return result.value === null
      ? { kind: CheckKind.enum.invalid }
      : { kind: CheckKind.enum.ok, principal: result.value };
  };

  // Whatever goes wrong creating the request — an Err or a throw — the page it would have served is closed again:
  // with no pending request there is nothing left to retire it.
  const startedGrant = async (effect: Extract<SignInEffect, { kind: typeof E.start_grant }>) => {
    const started = await run(() => startGrant(deps, effect.input)).then(
      (result) => result,
      async (cause: unknown) => {
        await closePage();
        throw cause;
      },
    );
    return started.isErr()
      ? ({ kind: O.grant_failed, error: formatAppError(started.error) } satisfies SignInObservation)
      : ({
          kind: O.grant_started,
          deviceCode: started.value.deviceCode,
          userCode: started.value.userCode,
          origin: effect.origin,
        } satisfies SignInObservation);
  };

  const perform = async (effect: SignInEffect, hooks: SignInHooks): Promise<SignInObservation | undefined> => {
    switch (effect.kind) {
      case E.check_credential:
        return {
          kind: O.credential_checked,
          source: effect.source,
          token: effect.token,
          result: await checkResult(effect.token),
        };
      case E.load_saved:
        return (await loadSaved(effect.tolerateUnreadable)).match(
          (token): SignInObservation => ({ kind: O.saved_loaded, purpose: effect.purpose, token }),
          (): SignInObservation => ({ kind: O.saved_unreadable }),
        );
      case E.clear_saved_if: {
        const loaded = await loadSaved(effect.tolerateUnreadable);
        if (loaded.isErr()) return { kind: O.saved_unreadable };
        if (loaded.value === effect.token) await store.clear();
        return { kind: O.saved_cleared, next: effect.next };
      }
      case E.save_credential:
        return {
          kind: O.saved,
          then: effect.then,
          signedIn: effect.signedIn,
          ok: await store.save(effect.signedIn.token),
        };
      case E.revoke_credential: {
        const revoked = await run(() => revokeSignInByHash(deps, deps.secrets.hashSecret(effect.token)));
        return {
          kind: O.revoked,
          reason: effect.reason,
          token: effect.token,
          ok: revoked.isOk(),
          error: revoked.isErr() ? formatAppError(revoked.error) : null,
        };
      }
      case E.name_page:
        return {
          kind: O.page_named,
          purpose: effect.purpose,
          origin: namedOrigin(),
          canServe: options.startPage !== undefined,
        };
      case E.serve_page:
        return { kind: O.page_served, purpose: effect.purpose, origin: await servePage() };
      case E.start_grant:
        return startedGrant(effect);
      case E.redeem_grant: {
        const redeemed = await run(() => redeemGrant(deps, effect.deviceCode));
        return {
          kind: O.redeemed,
          then: effect.then,
          result: redeemed.isErr()
            ? { kind: REDEEM_ERROR_KIND, error: formatAppError(redeemed.error) }
            : redeemed.value,
        };
      }
      case E.check_owner:
        return {
          kind: O.owner_checked,
          purpose: effect.purpose,
          unclaimed: await ownerNeedsSetup(deps),
          origin: effect.origin,
        };
      case E.close_page:
        await closePage();
        return undefined;
      case E.wait:
        await hooks.wait(effect.ms);
        return undefined;
      case E.present:
        hooks.present(effect.presentation);
        return undefined;
    }
  };

  // In order, one after the other. A step ends with at most one asking effect and it is the last, so the answer to
  // hand back is the one the rest of the list ends in, if any.
  const performAll = async (
    effects: readonly SignInEffect[],
    hooks: SignInHooks,
  ): Promise<SignInObservation | undefined> => {
    const [effect, ...rest] = effects;
    if (effect === undefined) return undefined;
    const answer = await perform(effect, hooks);
    return (await performAll(rest, hooks)) ?? answer;
  };

  const drive: SignInInterpreter['drive'] = async (state, observation, config, hooks) => {
    const step = nextStep(state, observation, config);
    hooks.progress(step.state);
    const answer = await performAll(step.effects, hooks);
    return answer === undefined ? step.state : drive(step.state, answer, config, hooks);
  };

  return { drive, release: closePage };
};
