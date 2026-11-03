import { ok, type Result } from 'neverthrow';
import type { KeychainFailure } from '../../models/auth/sign-in.js';
import { formatAppError } from '../../common/errors.js';
import { authenticateToken, revokeSignInByHash } from '../../controllers/auth/access-tokens.js';
import { ownerNeedsSetup } from '../../controllers/auth/owner.js';
import type {
  AuthDeps,
  RunEffects,
  SignInHooks,
  SignInInterpreter,
  SignInServer,
  SignInStore,
} from '../../controllers/deps.js';
import { redeemGrant, startGrant } from '../../controllers/auth/grants.js';
import {
  CheckKind,
  EffectKind,
  ObservationKind,
  REDEEM_ERROR_KIND,
  type CheckResult,
  type SignInEffect,
  type SignInObservation,
} from '../../models/auth/sign-in-flow.js';
import { nextStep } from '../../logic/auth/sign-in-flow.js';
import { PrincipalVia } from '../../models/auth/principal.js';

export type SignInInterpreterOptions = {
  deps: AuthDeps;
  run: RunEffects;
  store: SignInStore;
  origin: () => string | null;
  startPage?: (() => Promise<SignInServer>) | undefined;
};

const E = EffectKind.enum;
const O = ObservationKind.enum;

type Performer<K extends EffectKind> = (
  effect: Extract<SignInEffect, { kind: K }>,
  hooks: SignInHooks,
) => Promise<SignInObservation | undefined>;

type TemporaryPage = {
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
