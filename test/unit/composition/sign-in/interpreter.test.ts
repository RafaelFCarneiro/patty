import { err, errAsync, ok, okAsync } from 'neverthrow';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SignInHooks, SignInServer, SignInStore } from '../../../../src/controllers/deps.js';
import { formatAppError } from '../../../../src/common/errors.js';
import { createSignInInterpreter } from '../../../../src/composition/sign-in/interpreter.js';
import { nextStep } from '../../../../src/logic/auth/sign-in-flow.js';
import { conflict } from '../../../../src/models/error.js';
import {
  ClearNext,
  EffectKind,
  IDLE,
  ObservationKind,
  PagePurpose,
  REDEEM_ERROR_KIND,
  type SignInConfig,
  type SignInEffect,
  type SignInObservation,
} from '../../../../src/models/auth/sign-in-flow.js';

vi.mock('../../../../src/logic/auth/sign-in-flow.js', () => ({ nextStep: vi.fn() }));

const E = EffectKind.enum;
const O = ObservationKind.enum;
const CONFIG = {} as SignInConfig;

const hooks: SignInHooks = { present: vi.fn(), wait: vi.fn(async () => undefined), progress: vi.fn() };

const makeStore = (load: SignInStore['load']): SignInStore => ({
  load,
  save: vi.fn(async () => true),
  clear: vi.fn(async () => undefined),
});

const page = (overrides: Partial<SignInServer> = {}): SignInServer => ({
  origin: 'http://localhost:4000',
  close: vi.fn(async () => undefined),
  ...overrides,
});

type Setup = {
  run?: (flow: () => unknown) => Promise<unknown>;
  store?: SignInStore;
  origin?: () => string | null;
  startPage?: () => Promise<SignInServer>;
};

/** Drives one step that asks for `effect` and returns the observation the interpreter hands back to the protocol. */
const answerTo = async (effect: SignInEffect, setup: Setup = {}) => {
  const interpreter = createSignInInterpreter({
    deps: {} as never,
    run: (setup.run ?? (async () => ok(null))) as never,
    store: setup.store ?? makeStore(() => okAsync(null)),
    origin: setup.origin ?? (() => null),
    startPage: setup.startPage,
  });
  const step = vi.mocked(nextStep);
  step.mockReturnValueOnce({ state: IDLE, effects: [effect] }).mockReturnValue({ state: IDLE, effects: [] });
  await interpreter.drive(IDLE, { kind: O.requested }, CONFIG, hooks);
  return step.mock.calls[1]?.[1] as SignInObservation | undefined;
};

beforeEach(() => {
  vi.mocked(nextStep).mockReset();
});

describe('the sign-in interpreter — what each effect reports back', () => {
  it('clear_saved_if reports an unreadable keychain, clearing nothing, when not tolerated', async () => {
    const store = makeStore(() => errAsync({ code: 'keychain_unavailable' } as never));

    const observation = await answerTo(
      { kind: E.clear_saved_if, token: 't', next: ClearNext.enum.ask, tolerateUnreadable: false },
      { store },
    );

    expect(observation).toEqual({ kind: O.saved_unreadable });
    expect(store.clear).not.toHaveBeenCalled();
  });

  it('clear_saved_if clears only a saved sign-in that still holds the token', async () => {
    const holding = makeStore(() => okAsync('t'));
    const replaced = makeStore(() => okAsync('someone-elses'));
    const effect = { kind: E.clear_saved_if, token: 't', next: ClearNext.enum.signed_out, tolerateUnreadable: true };

    expect(await answerTo(effect, { store: holding })).toEqual({ kind: O.saved_cleared, next: 'signed_out' });
    expect(await answerTo(effect, { store: replaced })).toEqual({ kind: O.saved_cleared, next: 'signed_out' });

    expect(holding.clear).toHaveBeenCalledOnce();
    expect(replaced.clear).not.toHaveBeenCalled();
  });

  it('clear_saved_if treats an unreadable keychain as nothing saved when the protocol tolerates it', async () => {
    const store = makeStore(() => errAsync({ code: 'keychain_unavailable' } as never));

    const observation = await answerTo(
      { kind: E.clear_saved_if, token: 't', next: ClearNext.enum.ask, tolerateUnreadable: true },
      { store },
    );

    expect(observation).toEqual({ kind: O.saved_cleared, next: 'ask' });
    expect(store.clear).not.toHaveBeenCalled();
  });

  it('redeem_grant turns a failed redemption into the error outcome carrying the formatted message', async () => {
    const observation = await answerTo(
      { kind: E.redeem_grant, deviceCode: 'device', then: 'poll' },
      { run: async () => err(conflict) },
    );

    expect(observation).toEqual({
      kind: O.redeemed,
      then: 'poll',
      result: { kind: REDEEM_ERROR_KIND, error: formatAppError(conflict) },
    });
  });

  it('start_grant reports a failed request as grant_failed', async () => {
    const observation = await answerTo(
      { kind: E.start_grant, input: {} as never, origin: 'http://o' },
      { run: async () => err(conflict) },
    );

    expect(observation).toEqual({ kind: O.grant_failed, error: formatAppError(conflict) });
  });

  it('start_grant closes the temporary page it was started for when the request throws, and rethrows', async () => {
    const server = page();
    const interpreter = createSignInInterpreter({
      deps: {} as never,
      run: (async () => {
        throw new Error('database gone');
      }) as never,
      store: makeStore(() => okAsync(null)),
      origin: () => null,
      startPage: async () => server,
    });
    vi.mocked(nextStep)
      .mockReturnValueOnce({ state: IDLE, effects: [{ kind: E.serve_page, purpose: PagePurpose.enum.login }] })
      .mockReturnValueOnce({
        state: IDLE,
        effects: [{ kind: E.start_grant, input: {} as never, origin: server.origin }],
      });

    await expect(interpreter.drive(IDLE, { kind: O.requested }, CONFIG, hooks)).rejects.toThrow('database gone');
    expect(server.close).toHaveBeenCalledOnce();
  });
});

describe('the sign-in interpreter — the temporary page', () => {
  it('serve_page names no origin when this process has no way to serve one', async () => {
    const observation = await answerTo({ kind: E.serve_page, purpose: PagePurpose.enum.login });

    expect(observation).toEqual({ kind: O.page_served, purpose: 'login', origin: null });
  });

  it('serve_page names the page it started, and name_page then prefers it to the configured origin', async () => {
    const server = page();
    const interpreter = createSignInInterpreter({
      deps: {} as never,
      run: (async () => ok(null)) as never,
      store: makeStore(() => okAsync(null)),
      origin: () => 'https://configured.example',
      startPage: async () => server,
    });
    const step = vi.mocked(nextStep);
    step
      .mockReturnValueOnce({ state: IDLE, effects: [{ kind: E.name_page, purpose: PagePurpose.enum.login }] })
      .mockReturnValueOnce({ state: IDLE, effects: [{ kind: E.serve_page, purpose: PagePurpose.enum.login }] })
      .mockReturnValueOnce({ state: IDLE, effects: [{ kind: E.name_page, purpose: PagePurpose.enum.login }] })
      .mockReturnValue({ state: IDLE, effects: [] });

    await interpreter.drive(IDLE, { kind: O.requested }, CONFIG, hooks);

    expect(step.mock.calls.slice(1).map(([, observation]) => observation)).toEqual([
      { kind: O.page_named, purpose: 'login', origin: 'https://configured.example', canServe: true },
      { kind: O.page_served, purpose: 'login', origin: server.origin },
      { kind: O.page_named, purpose: 'login', origin: server.origin, canServe: true },
    ]);
  });

  it('name_page says it cannot serve a page when no way to start one was given', async () => {
    const observation = await answerTo({ kind: E.name_page, purpose: PagePurpose.enum.instructions });

    expect(observation).toMatchObject({ kind: O.page_named, origin: null, canServe: false });
  });

  it('release closes the page it started, once, and a close that fails is swallowed', async () => {
    const server = page({ close: vi.fn(async () => Promise.reject(new Error('already closed'))) });
    const interpreter = createSignInInterpreter({
      deps: {} as never,
      run: (async () => ok(null)) as never,
      store: makeStore(() => okAsync(null)),
      origin: () => null,
      startPage: async () => server,
    });
    vi.mocked(nextStep)
      .mockReturnValueOnce({ state: IDLE, effects: [{ kind: E.serve_page, purpose: PagePurpose.enum.login }] })
      .mockReturnValue({ state: IDLE, effects: [] });
    await interpreter.drive(IDLE, { kind: O.requested }, CONFIG, hooks);

    await expect(interpreter.release()).resolves.toBeUndefined();
    await interpreter.release();

    expect(server.close).toHaveBeenCalledOnce();
  });
});

describe('the sign-in interpreter — telling effects', () => {
  it('runs the effects of a step in order, answers with the last asking one, drives on until none', async () => {
    const wait = vi.fn(async () => undefined);
    const present = vi.fn();
    const interpreter = createSignInInterpreter({
      deps: {} as never,
      run: (async () => ok(null)) as never,
      store: makeStore(() => okAsync('saved-token')),
      origin: () => null,
    });
    const presentation = { kind: 'waiting' } as const;
    vi.mocked(nextStep)
      .mockReturnValueOnce({
        state: IDLE,
        effects: [
          { kind: E.wait, ms: 250 },
          { kind: E.present, presentation },
          { kind: E.load_saved, purpose: 'resolve', tolerateUnreadable: true },
        ],
      })
      .mockReturnValue({ state: { kind: 'denied' }, effects: [] });

    const final = await interpreter.drive(IDLE, { kind: O.requested }, CONFIG, { ...hooks, wait, present });

    expect(wait).toHaveBeenCalledWith(250);
    expect(present).toHaveBeenCalledWith(presentation);
    expect(vi.mocked(nextStep).mock.calls[1]?.[1]).toEqual({
      kind: O.saved_loaded,
      purpose: 'resolve',
      token: 'saved-token',
    });
    expect(final).toEqual({ kind: 'denied' });
  });
});
