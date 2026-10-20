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
import {
  CheckKind,
  EffectKind,
  ObservationKind,
  REDEEM_ERROR_KIND,
  type CheckResult,
  type SignInEffect,
  type SignInObservation,
} from '../../models/auth/signInFlow.js';
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

type Performer<K extends EffectKind> = (
  effect: Extract<SignInEffect, { kind: K }>,
  hooks: SignInHooks,
) => Promise<SignInObservation | undefined>;

type TemporaryPage = {
  /** A temporary page, once started, is the page its pending request was announced at, so it is named first. */
  namedOrigin: () => string | null;
  serve: () => Promise<string | null>;
  close: () => Promise<void>;
  canServe: boolean;
};

type PerformerContext = Pick<SignInInterpreterOptions, 'deps' | 'run' | 'store'> & { page: TemporaryPage };

const temporaryPage = (options: Pick<SignInInterpreterOptions, 'origin' | 'startPage'>): TemporaryPage => {
  let temporary: SignInServer | null = null;
  return {
    namedOrigin: () => temporary?.origin ?? options.origin(),
    serve: async () => {
      temporary = (await options.startPage?.()) ?? null;
      return temporary?.origin ?? null;
    },
    close: async () => {
      const server = temporary;
      temporary = null;
      await server?.close().catch(() => undefined);
    },
    canServe: options.startPage !== undefined,
  };
};

// An unreadable keychain is a `KeychainFailure`: whether it counts as "nothing saved" is the protocol's call
// (`tolerateUnreadable`); when it does not, the failure is reported back as an observation.
const loadSavedToken = async (
  store: SignInStore,
  tolerateUnreadable: boolean,
): Promise<Result<string | null, KeychainFailure>> => {
  const loaded = await store.load();
  return loaded.isErr() && tolerateUnreadable ? ok(null) : loaded;
};

const checkResult = async ({ deps, run }: PerformerContext, token: string): Promise<CheckResult> => {
  const result = await run(() => authenticateToken(deps, deps.secrets.hashSecret(token), PrincipalVia.enum.stdio));
  if (result.isErr()) return { kind: CheckKind.enum.failure };
  return result.value === null
    ? { kind: CheckKind.enum.invalid }
    : { kind: CheckKind.enum.ok, principal: result.value };
};

const performCheckCredential =
  (ctx: PerformerContext): Performer<typeof E.check_credential> =>
  async (effect) => ({
    kind: O.credential_checked,
    source: effect.source,
    token: effect.token,
    result: await checkResult(ctx, effect.token),
  });

const performLoadSaved =
  ({ store }: PerformerContext): Performer<typeof E.load_saved> =>
  async (effect) =>
    (await loadSavedToken(store, effect.tolerateUnreadable)).match(
      (token): SignInObservation => ({ kind: O.saved_loaded, purpose: effect.purpose, token }),
      (): SignInObservation => ({ kind: O.saved_unreadable }),
    );

const performClearSavedIf =
  ({ store }: PerformerContext): Performer<typeof E.clear_saved_if> =>
  async (effect) => {
    const loaded = await loadSavedToken(store, effect.tolerateUnreadable);
    if (loaded.isErr()) return { kind: O.saved_unreadable };
    if (loaded.value === effect.token) await store.clear();
    return { kind: O.saved_cleared, next: effect.next };
  };

const performSaveCredential =
  ({ store }: PerformerContext): Performer<typeof E.save_credential> =>
  async (effect) => ({
    kind: O.saved,
    then: effect.then,
    signedIn: effect.signedIn,
    ok: await store.save(effect.signedIn.token),
  });

const performRevokeCredential =
  ({ deps, run }: PerformerContext): Performer<typeof E.revoke_credential> =>
  async (effect) => {
    const revoked = await run(() => revokeSignInByHash(deps, deps.secrets.hashSecret(effect.token)));
    return {
      kind: O.revoked,
      reason: effect.reason,
      token: effect.token,
      ok: revoked.isOk(),
      error: revoked.isErr() ? formatAppError(revoked.error) : null,
    };
  };

const performNamePage =
  ({ page }: PerformerContext): Performer<typeof E.name_page> =>
  async (effect) => ({
    kind: O.page_named,
    purpose: effect.purpose,
    origin: page.namedOrigin(),
    canServe: page.canServe,
  });

const performServePage =
  ({ page }: PerformerContext): Performer<typeof E.serve_page> =>
  async (effect) => ({
    kind: O.page_served,
    purpose: effect.purpose,
    origin: await page.serve(),
  });

// Whatever goes wrong creating the request — an Err or a throw — the page it would have served is closed again:
// with no pending request there is nothing left to retire it.
const performStartGrant =
  ({ deps, run, page }: PerformerContext): Performer<typeof E.start_grant> =>
  async (effect) => {
    const started = await run(() => startGrant(deps, effect.input)).then(
      (result) => result,
      async (cause: unknown) => {
        await page.close();
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

const performRedeemGrant =
  ({ deps, run }: PerformerContext): Performer<typeof E.redeem_grant> =>
  async (effect) => {
    const redeemed = await run(() => redeemGrant(deps, effect.deviceCode));
    return {
      kind: O.redeemed,
      then: effect.then,
      result: redeemed.isErr() ? { kind: REDEEM_ERROR_KIND, error: formatAppError(redeemed.error) } : redeemed.value,
    };
  };

const performCheckOwner =
  ({ deps }: PerformerContext): Performer<typeof E.check_owner> =>
  async (effect) => ({
    kind: O.owner_checked,
    purpose: effect.purpose,
    unclaimed: await ownerNeedsSetup(deps),
    origin: effect.origin,
  });

const performClosePage =
  ({ page }: PerformerContext): Performer<typeof E.close_page> =>
  async () => {
    await page.close();
    return undefined;
  };

const performWait: Performer<typeof E.wait> = async (effect, hooks) => {
  await hooks.wait(effect.ms);
  return undefined;
};

const performPresent: Performer<typeof E.present> = async (effect, hooks) => {
  hooks.present(effect.presentation);
  return undefined;
};

const performersFor = (ctx: PerformerContext) =>
  ({
    [E.check_credential]: performCheckCredential(ctx),
    [E.load_saved]: performLoadSaved(ctx),
    [E.clear_saved_if]: performClearSavedIf(ctx),
    [E.save_credential]: performSaveCredential(ctx),
    [E.revoke_credential]: performRevokeCredential(ctx),
    [E.name_page]: performNamePage(ctx),
    [E.serve_page]: performServePage(ctx),
    [E.start_grant]: performStartGrant(ctx),
    [E.redeem_grant]: performRedeemGrant(ctx),
    [E.check_owner]: performCheckOwner(ctx),
    [E.close_page]: performClosePage(ctx),
    [E.wait]: performWait,
    [E.present]: performPresent,
  }) satisfies { [K in EffectKind]: Performer<K> };

export const createSignInInterpreter = (options: SignInInterpreterOptions): SignInInterpreter => {
  const page = temporaryPage(options);
  const performers = performersFor({ deps: options.deps, run: options.run, store: options.store, page });

  const perform = (effect: SignInEffect, hooks: SignInHooks): Promise<SignInObservation | undefined> =>
    (performers[effect.kind] as Performer<EffectKind>)(effect, hooks);

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

  return { drive, release: page.close };
};
