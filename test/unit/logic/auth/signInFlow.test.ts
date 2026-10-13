import { describe, expect, it } from 'vitest';
import { nextStep, pendingOf } from '../../../../src/logic/auth/signInFlow.js';
import { GrantChannel, SignInDuration, type SignedIn } from '../../../../src/models/auth/grant.js';
import { STDIO_MESSAGES } from '../../../../src/models/auth/message.js';
import { OWNER_USER_ID, UserRole } from '../../../../src/models/auth/owner.js';
import { PrincipalVia, type Principal } from '../../../../src/models/auth/principal.js';
import { GRANT_POLL_INTERVAL_MS } from '../../../../src/models/auth/signIn.js';
import {
  ASKING_EFFECT_KINDS,
  CheckKind,
  ClearNext,
  Continuation,
  CredentialSource,
  EffectKind,
  IDLE,
  LoadPurpose,
  ObservationKind,
  OwnerPurpose,
  PagePurpose,
  PresentationKind,
  REDEEM_ERROR_KIND,
  RevokeReason,
  SignInStateKind,
  type CheckResult,
  type HeldSignIn,
  type PendingSignIn,
  type RedeemOutcome,
  type Presentation,
  type SignInConfig,
  type SignInEffect,
  type SignInObservation,
  type SignInState,
} from '../../../../src/models/auth/signInFlow.js';
import { TokenAccess } from '../../../../src/models/auth/token.js';

const S = SignInStateKind.enum;
const O = ObservationKind.enum;
const E = EffectKind.enum;
const P = PresentationKind.enum;
const CHECK = CheckKind.enum;
const SOURCE = CredentialSource.enum;

const READ = 'fintrack:read' as const;
const WRITE = 'fintrack:write' as const;

const principal: Principal = {
  userId: OWNER_USER_ID,
  role: UserRole.enum.admin,
  scopes: [READ],
  via: PrincipalVia.enum.stdio,
};
const refreshed: Principal = { ...principal, scopes: [READ, WRITE] };

const CLIENT = { name: 'Claude Desktop', version: '1.2.3' };
const stdio: SignInConfig = {
  channel: GrantChannel.enum.stdio,
  profile: 'default',
  client: CLIENT,
  authRequired: true,
};
const stdioWithEnv: SignInConfig = { ...stdio, envToken: 'ftk_from-the-environment' };
const cli: SignInConfig = {
  channel: GrantChannel.enum.cli,
  profile: 'work',
  client: { name: 'fintrack login', version: '9.9.9' },
  authRequired: true,
  hint: { access: TokenAccess.enum.write, duration: SignInDuration.enum['7d'] },
};

const request: PendingSignIn = { deviceCode: 'device-secret', userCode: 'ABCD-EFGH' };
const held = (overrides: Partial<HeldSignIn> = {}): HeldSignIn => ({
  token: 'ftk_held',
  principal,
  ephemeral: false,
  ...overrides,
});

const pending: SignInState = { kind: S.pending, pending: request };
const signedIn = (overrides: Partial<HeldSignIn> = {}, open: PendingSignIn | null = null): SignInState => ({
  kind: S.signed_in,
  held: held(overrides),
  pending: open,
});

const redeemedAs = (duration: SignInDuration, scopes: SignedIn['scopes'] = [READ]): SignedIn => ({
  token: 'ftk_new',
  tokenId: 't-new',
  scopes,
  principal,
  duration,
  expiresAt: '2026-10-12T12:00:00.000Z',
});

const present = (presentation: Presentation): SignInEffect => ({ kind: E.present, presentation });
const closePage: SignInEffect = { kind: E.close_page };
const loadSaved: SignInEffect = { kind: E.load_saved, purpose: LoadPurpose.enum.resolve, tolerateUnreadable: true };
const openPage = (purpose: PagePurpose): SignInEffect => ({ kind: E.open_page, purpose });

type Row = {
  name: string;
  state: SignInState;
  observation: SignInObservation;
  config: SignInConfig;
  expected: { state: SignInState; effects: SignInEffect[] };
};

const row = (
  name: string,
  state: SignInState,
  observation: SignInObservation,
  config: SignInConfig,
  expected: Row['expected'],
): Row => ({ name, state, observation, config, expected });

const checked = (source: CredentialSource, token: string, result: CheckResult): SignInObservation => ({
  kind: O.credential_checked,
  source,
  token,
  result,
});

const ok = { kind: CHECK.ok, principal: refreshed } as const;
const invalid = { kind: CHECK.invalid } as const;
const failure = { kind: CHECK.failure } as const;

const redeemed = (then: Continuation, result: RedeemOutcome): SignInObservation => ({
  kind: O.redeemed,
  then,
  result,
});

const clearIf = (token: string, next: ClearNext, tolerateUnreadable = true): SignInEffect => ({
  kind: E.clear_saved_if,
  token,
  next,
  tolerateUnreadable,
});

const ASK = Continuation.enum.ask;
const POLL = Continuation.enum.poll;

const GRANT_INPUT_STDIO = { client: CLIENT, profile: 'default', channel: GrantChannel.enum.stdio };
const GRANT_INPUT_CLI = { client: cli.client, profile: 'work', channel: GrantChannel.enum.cli, hint: cli.hint };

describe('a gated stdio request', () => {
  const rows: Row[] = [
    row(
      'checks only the environment token when there is one — whatever else is held or pending',
      signedIn(),
      { kind: O.requested },
      stdioWithEnv,
      {
        state: signedIn(),
        effects: [{ kind: E.check_credential, source: SOURCE.env, token: 'ftk_from-the-environment' }],
      },
    ),
    row(
      'refuses a malformed environment token without looking anything up',
      IDLE,
      { kind: O.requested },
      {
        ...stdio,
        envToken: 'not-a-token',
      },
      { state: IDLE, effects: [present({ kind: P.invalid_env_token })] },
    ),
    row('looks in the keychain first when nothing is held', IDLE, { kind: O.requested }, stdio, {
      state: IDLE,
      effects: [loadSaved],
    }),
    row('looks in the keychain first even with a request already open', pending, { kind: O.requested }, stdio, {
      state: pending,
      effects: [loadSaved],
    }),
    row('re-validates what it holds on every request', signedIn(), { kind: O.requested }, stdio, {
      state: signedIn(),
      effects: [{ kind: E.check_credential, source: SOURCE.held, token: 'ftk_held' }],
    }),
  ];
  it.each(rows)('$name', ({ state, observation, config, expected }) => {
    expect(nextStep(state, observation, config)).toEqual(expected);
  });
});

describe('what a credential check came to', () => {
  const rows: Row[] = [
    // The environment's token is the only credential: it never falls back to anything.
    row('env ok → granted, state untouched', IDLE, checked(SOURCE.env, 'ftk_e', ok), stdioWithEnv, {
      state: IDLE,
      effects: [present({ kind: P.granted, principal: refreshed })],
    }),
    row(
      'env invalid → the invalid-token message, nothing forgotten, no fallback',
      signedIn(),
      checked(SOURCE.env, 'ftk_e', invalid),
      stdioWithEnv,
      {
        state: signedIn(),
        effects: [present({ kind: P.invalid_env_token })],
      },
    ),
    row('env failure → "could not check", not a sign-out', IDLE, checked(SOURCE.env, 'ftk_e', failure), stdioWithEnv, {
      state: IDLE,
      effects: [present({ kind: P.cannot_verify })],
    }),

    row('held ok → granted with the principal as it is now', signedIn(), checked(SOURCE.held, 'ftk_held', ok), stdio, {
      state: signedIn({ principal: refreshed }),
      effects: [present({ kind: P.granted, principal: refreshed })],
    }),
    row(
      'held failure → "could not check", the credential is kept',
      signedIn(),
      checked(SOURCE.held, 'ftk_held', failure),
      stdio,
      {
        state: signedIn(),
        effects: [present({ kind: P.cannot_verify })],
      },
    ),
    row(
      'held invalid, saved → forgotten, and cleared from the keychain only if it still holds it',
      signedIn(),
      checked(SOURCE.held, 'ftk_held', invalid),
      stdio,
      {
        state: IDLE,
        effects: [clearIf('ftk_held', ClearNext.enum.load_saved)],
      },
    ),
    row(
      'held invalid, memory only → forgotten, the keychain is never touched',
      signedIn({ ephemeral: true }),
      checked(SOURCE.held, 'ftk_held', invalid),
      stdio,
      {
        state: IDLE,
        effects: [loadSaved],
      },
    ),
    row(
      'held invalid with a request still open → only the request remains',
      signedIn({}, request),
      checked(SOURCE.held, 'ftk_held', invalid),
      stdio,
      {
        state: pending,
        effects: [clearIf('ftk_held', ClearNext.enum.load_saved)],
      },
    ),

    row('saved ok → held (saved, not ephemeral) and granted', IDLE, checked(SOURCE.saved, 'ftk_saved', ok), stdio, {
      state: signedIn({ token: 'ftk_saved', principal: refreshed }),
      effects: [present({ kind: P.granted, principal: refreshed })],
    }),
    row('saved ok keeps the request open behind it', pending, checked(SOURCE.saved, 'ftk_saved', ok), stdio, {
      state: signedIn({ token: 'ftk_saved', principal: refreshed }, request),
      effects: [present({ kind: P.granted, principal: refreshed })],
    }),
    row(
      'saved failure → "could not check", nothing cleared',
      pending,
      checked(SOURCE.saved, 'ftk_saved', failure),
      stdio,
      {
        state: pending,
        effects: [present({ kind: P.cannot_verify })],
      },
    ),
    row(
      'saved invalid → cleared only if still the same one, then ask in the browser',
      IDLE,
      checked(SOURCE.saved, 'ftk_saved', invalid),
      stdio,
      {
        state: IDLE,
        effects: [clearIf('ftk_saved', ClearNext.enum.ask)],
      },
    ),
  ];
  it.each(rows)('$name', ({ state, observation, config, expected }) => {
    expect(nextStep(state, observation, config)).toEqual(expected);
  });

  it('a held-credential answer with nothing held changes nothing', () => {
    expect(nextStep(IDLE, checked(SOURCE.held, 'ftk_held', ok), stdio)).toEqual({ state: IDLE, effects: [] });
  });
});

describe('the keychain, and what to do once it has been looked at', () => {
  const rows: Row[] = [
    row(
      'a saved sign-in is checked before it is believed',
      IDLE,
      { kind: O.saved_loaded, purpose: LoadPurpose.enum.resolve, token: 'ftk_saved' },
      stdio,
      {
        state: IDLE,
        effects: [{ kind: E.check_credential, source: SOURCE.saved, token: 'ftk_saved' }],
      },
    ),
    row(
      'nothing saved and no request → a page to ask on',
      IDLE,
      { kind: O.saved_loaded, purpose: LoadPurpose.enum.resolve, token: null },
      stdio,
      {
        state: IDLE,
        effects: [openPage(PagePurpose.enum.new_request)],
      },
    ),
    row(
      'nothing saved with a request open → look at that request, ask nothing new',
      pending,
      { kind: O.saved_loaded, purpose: LoadPurpose.enum.resolve, token: null },
      stdio,
      {
        state: pending,
        effects: [{ kind: E.redeem_grant, deviceCode: 'device-secret', then: ASK }],
      },
    ),
    row(
      'logout with nothing saved says so',
      IDLE,
      { kind: O.saved_loaded, purpose: LoadPurpose.enum.logout, token: null },
      cli,
      {
        state: IDLE,
        effects: [present({ kind: P.not_signed_in, profile: 'work' })],
      },
    ),
    row(
      'logout with a saved sign-in revokes it first',
      IDLE,
      { kind: O.saved_loaded, purpose: LoadPurpose.enum.logout, token: 'ftk_saved' },
      cli,
      {
        state: IDLE,
        effects: [{ kind: E.revoke_credential, token: 'ftk_saved', reason: RevokeReason.enum.logout }],
      },
    ),
    row(
      'after clearing a forgotten credential → the keychain is read for another',
      IDLE,
      { kind: O.saved_cleared, next: ClearNext.enum.load_saved },
      stdio,
      {
        state: IDLE,
        effects: [loadSaved],
      },
    ),
    row(
      'after clearing an invalid saved one → ask in the browser',
      IDLE,
      { kind: O.saved_cleared, next: ClearNext.enum.ask },
      stdio,
      {
        state: IDLE,
        effects: [openPage(PagePurpose.enum.new_request)],
      },
    ),
    row(
      'after clearing for logout → signed out',
      IDLE,
      { kind: O.saved_cleared, next: ClearNext.enum.signed_out },
      cli,
      {
        state: IDLE,
        effects: [present({ kind: P.signed_out, profile: 'work' })],
      },
    ),
  ];
  it.each(rows)('$name', ({ state, observation, config, expected }) => {
    expect(nextStep(state, observation, config)).toEqual(expected);
  });

  it('only a stdio session treats an unreadable keychain as "nothing saved"; logout must not', () => {
    const forStdio = nextStep(IDLE, { kind: O.requested }, stdio).effects[0];
    const forLogout = nextStep(IDLE, { kind: O.logout_requested }, cli).effects[0];
    expect(forStdio).toMatchObject({ kind: E.load_saved, tolerateUnreadable: true });
    expect(forLogout).toMatchObject({
      kind: E.load_saved,
      purpose: LoadPurpose.enum.logout,
      tolerateUnreadable: false,
    });
  });
});

describe('opening a page and starting the request', () => {
  const rows: Row[] = [
    row(
      'a page was named → start the request there',
      IDLE,
      { kind: O.page_opened, purpose: PagePurpose.enum.new_request, origin: 'http://127.0.0.1:1' },
      stdio,
      {
        state: IDLE,
        effects: [{ kind: E.start_grant, input: GRANT_INPUT_STDIO, origin: 'http://127.0.0.1:1' }],
      },
    ),
    row(
      'no page at all for a stdio session → just say how else to sign in',
      IDLE,
      { kind: O.page_opened, purpose: PagePurpose.enum.new_request, origin: null },
      stdio,
      {
        state: IDLE,
        effects: [{ kind: E.name_page }],
      },
    ),
    row(
      'login passes the hint it was given to the request',
      IDLE,
      { kind: O.page_opened, purpose: PagePurpose.enum.login, origin: 'http://localhost:2' },
      cli,
      {
        state: IDLE,
        effects: [{ kind: E.start_grant, input: GRANT_INPUT_CLI, origin: 'http://localhost:2' }],
      },
    ),
    row(
      'login cannot go on with no page',
      IDLE,
      { kind: O.page_opened, purpose: PagePurpose.enum.login, origin: null },
      cli,
      {
        state: { kind: S.failed },
        effects: [present({ kind: P.failed, reason: STDIO_MESSAGES.notSignedInWithoutHttp })],
      },
    ),

    row(
      'stdio: a started request is pending, and the instructions are shown',
      IDLE,
      {
        kind: O.grant_started,
        deviceCode: 'device-secret',
        userCode: 'ABCD-EFGH',
        origin: 'http://127.0.0.1:1',
      },
      stdio,
      { state: pending, effects: [{ kind: E.name_page }] },
    ),
    row(
      'login: a started request prints the link and the code, then waits',
      IDLE,
      {
        kind: O.grant_started,
        deviceCode: 'device-secret',
        userCode: 'ABCD-EFGH',
        origin: 'http://localhost:2',
      },
      cli,
      {
        state: pending,
        effects: [
          present({ kind: P.open, url: 'http://localhost:2/ui/connect?code=ABCD-EFGH', code: 'ABCD-EFGH' }),
          present({ kind: P.waiting }),
        ],
      },
    ),
    row(
      'stdio: a request that could not be created releases its page and says it could not check',
      IDLE,
      { kind: O.grant_failed, error: 'boom' },
      stdio,
      {
        state: IDLE,
        effects: [closePage, present({ kind: P.cannot_verify })],
      },
    ),
    row(
      'login: a request that could not be created ends the attempt with the reason',
      IDLE,
      { kind: O.grant_failed, error: 'boom' },
      cli,
      {
        state: { kind: S.failed },
        effects: [closePage, present({ kind: P.failed, reason: 'boom' })],
      },
    ),
  ];
  it.each(rows)('$name', ({ state, observation, config, expected }) => {
    expect(nextStep(state, observation, config)).toEqual(expected);
  });
});

describe('the owner, and the instructions', () => {
  const rows: Row[] = [
    row(
      'the page is named → the owner is looked at before the instructions are written',
      pending,
      { kind: O.page_named, origin: 'http://127.0.0.1:1' },
      stdio,
      {
        state: pending,
        effects: [{ kind: E.check_owner, purpose: OwnerPurpose.enum.instructions, origin: 'http://127.0.0.1:1' }],
      },
    ),
    row(
      'instructions carry the user code only when there is a page',
      pending,
      {
        kind: O.owner_checked,
        purpose: OwnerPurpose.enum.instructions,
        unclaimed: false,
        origin: 'http://127.0.0.1:1',
      },
      stdio,
      {
        state: pending,
        effects: [
          present({ kind: P.instructions, origin: 'http://127.0.0.1:1', userCode: 'ABCD-EFGH', ownerUnclaimed: false }),
        ],
      },
    ),
    row(
      '…and none without one, whatever is pending',
      pending,
      { kind: O.owner_checked, purpose: OwnerPurpose.enum.instructions, unclaimed: true, origin: null },
      stdio,
      {
        state: pending,
        effects: [present({ kind: P.instructions, origin: null, userCode: null, ownerUnclaimed: true })],
      },
    ),
    row(
      'instructions with no request carry no code',
      IDLE,
      {
        kind: O.owner_checked,
        purpose: OwnerPurpose.enum.instructions,
        unclaimed: false,
        origin: 'http://127.0.0.1:1',
      },
      stdio,
      {
        state: IDLE,
        effects: [
          present({ kind: P.instructions, origin: 'http://127.0.0.1:1', userCode: null, ownerUnclaimed: false }),
        ],
      },
    ),
    row(
      'login: an unclaimed owner ends the attempt before anything is started',
      IDLE,
      { kind: O.owner_checked, purpose: OwnerPurpose.enum.login, unclaimed: true, origin: null },
      cli,
      {
        state: { kind: S.failed },
        effects: [present({ kind: P.owner_unclaimed })],
      },
    ),
    row(
      'login: a claimed owner → a page to approve on',
      IDLE,
      { kind: O.owner_checked, purpose: OwnerPurpose.enum.login, unclaimed: false, origin: null },
      cli,
      {
        state: IDLE,
        effects: [openPage(PagePurpose.enum.login)],
      },
    ),
  ];
  it.each(rows)('$name', ({ state, observation, config, expected }) => {
    expect(nextStep(state, observation, config)).toEqual(expected);
  });
});

describe('the answer to a request', () => {
  const session = redeemedAs(SignInDuration.enum.session);
  const day = redeemedAs(SignInDuration.enum['24h']);
  const write = redeemedAs(SignInDuration.enum['24h'], [READ, WRITE]);
  const adopted = (signedInAs: SignedIn, ephemeral: boolean, open: PendingSignIn | null = null): SignInState =>
    signedIn({ token: signedInAs.token, principal: signedInAs.principal, ephemeral }, open);
  const save = (signedInAs: SignedIn, then: Continuation): SignInEffect => ({
    kind: E.save_credential,
    signedIn: signedInAs,
    then,
  });
  const nextRequest = openPage(PagePurpose.enum.new_request);

  const rows: Row[] = [
    // stdio — a gated request asks again; the timer only retires what is spent.
    row(
      'stdio ask: still pending → show the instructions, ask nothing new',
      pending,
      redeemed(ASK, { kind: 'pending' }),
      stdio,
      { state: pending, effects: [{ kind: E.name_page }] },
    ),
    row(
      'stdio ask: a failed lookup is treated as still pending',
      pending,
      redeemed(ASK, { kind: REDEEM_ERROR_KIND, error: 'busy' }),
      stdio,
      { state: pending, effects: [{ kind: E.name_page }] },
    ),
    row('stdio ask: denied → page released, a fresh request', pending, redeemed(ASK, { kind: 'denied' }), stdio, {
      state: IDLE,
      effects: [closePage, nextRequest],
    }),
    row('stdio ask: expired → page released, a fresh request', pending, redeemed(ASK, { kind: 'expired' }), stdio, {
      state: IDLE,
      effects: [closePage, nextRequest],
    }),
    row(
      'stdio ask: already answered or unknown → page released, a fresh request',
      pending,
      redeemed(ASK, { kind: 'invalid' }),
      stdio,
      { state: IDLE, effects: [closePage, nextRequest] },
    ),
    row(
      'stdio ask: a 24 hour sign-in is saved before it is granted',
      pending,
      redeemed(ASK, { kind: 'signed_in', ...day }),
      stdio,
      { state: pending, effects: [save(day, ASK)] },
    ),
    row(
      'stdio ask: "this session only" never reaches the keychain',
      pending,
      redeemed(ASK, { kind: 'signed_in', ...session }),
      stdio,
      {
        state: adopted(session, true),
        effects: [closePage, present({ kind: P.granted, principal })],
      },
    ),
    row('stdio poll: still pending → nothing', pending, redeemed(POLL, { kind: 'pending' }), stdio, {
      state: pending,
      effects: [],
    }),
    row(
      'stdio poll: a failed lookup → nothing',
      pending,
      redeemed(POLL, { kind: REDEEM_ERROR_KIND, error: 'busy' }),
      stdio,
      { state: pending, effects: [] },
    ),
    row(
      'stdio poll: denied → the request is retired, nothing new is started',
      pending,
      redeemed(POLL, { kind: 'denied' }),
      stdio,
      { state: IDLE, effects: [closePage] },
    ),
    row('stdio poll: expired → the request is retired', pending, redeemed(POLL, { kind: 'expired' }), stdio, {
      state: IDLE,
      effects: [closePage],
    }),
    row(
      'stdio poll: retiring a request leaves a credential found elsewhere in place',
      signedIn({}, request),
      redeemed(POLL, { kind: 'denied' }),
      stdio,
      { state: signedIn(), effects: [closePage] },
    ),
    row(
      'stdio poll: approval is saved, and nothing is presented',
      pending,
      redeemed(POLL, { kind: 'signed_in', ...day }),
      stdio,
      { state: pending, effects: [save(day, POLL)] },
    ),
    row(
      'stdio poll: a "this session only" approval is adopted silently',
      pending,
      redeemed(POLL, { kind: 'signed_in', ...session }),
      stdio,
      { state: adopted(session, true), effects: [closePage] },
    ),

    // saved?
    row(
      'stdio: saved → held as saved, page released, granted',
      pending,
      { kind: O.saved, then: ASK, signedIn: day, ok: true },
      stdio,
      {
        state: adopted(day, false),
        effects: [closePage, present({ kind: P.granted, principal })],
      },
    ),
    row(
      'stdio: saved (poll) → held as saved, page released, silent',
      pending,
      { kind: O.saved, then: POLL, signedIn: day, ok: true },
      stdio,
      {
        state: adopted(day, false),
        effects: [closePage],
      },
    ),
    row(
      'stdio: a keychain that refuses → kept in memory (ephemeral), granted',
      pending,
      { kind: O.saved, then: ASK, signedIn: day, ok: false },
      stdio,
      {
        state: adopted(day, true),
        effects: [closePage, present({ kind: P.granted, principal })],
      },
    ),

    // cli — one loop; a failed lookup ends it.
    row('login: still pending → wait', pending, redeemed(POLL, { kind: 'pending' }), cli, {
      state: pending,
      effects: [{ kind: E.wait, ms: GRANT_POLL_INTERVAL_MS }],
    }),
    row(
      'login: a failed lookup ends the attempt with the reason',
      pending,
      redeemed(POLL, { kind: REDEEM_ERROR_KIND, error: 'busy' }),
      cli,
      {
        state: { kind: S.failed },
        effects: [closePage, present({ kind: P.failed, reason: 'busy' })],
      },
    ),
    row('login: denied ends the attempt', pending, redeemed(POLL, { kind: 'denied' }), cli, {
      state: { kind: S.denied },
      effects: [closePage, present({ kind: P.denied })],
    }),
    row('login: expired ends the attempt', pending, redeemed(POLL, { kind: 'expired' }), cli, {
      state: { kind: S.expired },
      effects: [closePage, present({ kind: P.expired })],
    }),
    row('login: an unknown or spent request counts as expired', pending, redeemed(POLL, { kind: 'invalid' }), cli, {
      state: { kind: S.expired },
      effects: [closePage, present({ kind: P.expired })],
    }),
    row('login: approval is saved first', pending, redeemed(POLL, { kind: 'signed_in', ...write }), cli, {
      state: pending,
      effects: [save(write, POLL)],
    }),
    row(
      'login: saved → signed in, with the access that was granted',
      pending,
      { kind: O.saved, then: POLL, signedIn: write, ok: true },
      cli,
      {
        state: adopted(write, false),
        effects: [
          closePage,
          present({ kind: P.signed_in, profile: 'work', access: TokenAccess.enum.write, expiresAt: write.expiresAt }),
        ],
      },
    ),
    row('login: a read-only sign-in says read', pending, { kind: O.saved, then: POLL, signedIn: day, ok: true }, cli, {
      state: adopted(day, false),
      effects: [
        closePage,
        present({ kind: P.signed_in, profile: 'work', access: TokenAccess.enum.read, expiresAt: day.expiresAt }),
      ],
    }),
    row(
      'login: a keychain that refuses means the sign-in is taken back',
      pending,
      { kind: O.saved, then: POLL, signedIn: day, ok: false },
      cli,
      {
        state: pending,
        effects: [{ kind: E.revoke_credential, token: 'ftk_new', reason: RevokeReason.enum.keychain_refused }],
      },
    ),
  ];
  it.each(rows)('$name', ({ state, observation, config, expected }) => {
    expect(nextStep(state, observation, config)).toEqual(expected);
  });
});

describe('revoking', () => {
  const rows: Row[] = [
    row(
      'a refusing keychain, sign-in revoked → say it was taken back',
      pending,
      { kind: O.revoked, reason: RevokeReason.enum.keychain_refused, token: 'ftk_new', ok: true, error: null },
      cli,
      {
        state: { kind: S.failed },
        effects: [closePage, present({ kind: P.keychain_refused })],
      },
    ),
    row(
      'a refusing keychain, revocation failed → say it is still active',
      pending,
      { kind: O.revoked, reason: RevokeReason.enum.keychain_refused, token: 'ftk_new', ok: false, error: 'conflict' },
      cli,
      {
        state: { kind: S.failed },
        effects: [closePage, present({ kind: P.keychain_refused_still_active })],
      },
    ),
    row(
      'logout: revoked → clear the keychain entry, but only if it is still that one',
      IDLE,
      { kind: O.revoked, reason: RevokeReason.enum.logout, token: 'ftk_saved', ok: true, error: null },
      cli,
      {
        state: IDLE,
        effects: [clearIf('ftk_saved', ClearNext.enum.signed_out, false)],
      },
    ),
    row(
      'logout: not revoked → fail and leave the entry alone',
      IDLE,
      { kind: O.revoked, reason: RevokeReason.enum.logout, token: 'ftk_saved', ok: false, error: 'conflict' },
      cli,
      {
        state: { kind: S.failed },
        effects: [present({ kind: P.logout_failed, reason: 'conflict' })],
      },
    ),
    row(
      'close: the answer changes nothing',
      IDLE,
      { kind: O.revoked, reason: RevokeReason.enum.close, token: 'ftk_held', ok: false, error: 'conflict' },
      stdio,
      {
        state: IDLE,
        effects: [],
      },
    ),
  ];
  it.each(rows)('$name', ({ state, observation, config, expected }) => {
    expect(nextStep(state, observation, config)).toEqual(expected);
  });
});

describe('what an edge feeds', () => {
  const rows: Row[] = [
    row('a tick with a request open → look at it, quietly', pending, { kind: O.ticked }, stdio, {
      state: pending,
      effects: [{ kind: E.redeem_grant, deviceCode: 'device-secret', then: POLL }],
    }),
    row(
      'a tick with a request open behind a credential → still look',
      signedIn({}, request),
      { kind: O.ticked },
      stdio,
      {
        state: signedIn({}, request),
        effects: [{ kind: E.redeem_grant, deviceCode: 'device-secret', then: POLL }],
      },
    ),
    row('a tick with nothing open → nothing', IDLE, { kind: O.ticked }, stdio, { state: IDLE, effects: [] }),
    row('a tick with a credential and nothing open → nothing', signedIn(), { kind: O.ticked }, stdio, {
      state: signedIn(),
      effects: [],
    }),

    row(
      'login with auth disabled → refused, nothing opened',
      IDLE,
      { kind: O.login_requested },
      { ...cli, authRequired: false },
      {
        state: { kind: S.failed },
        effects: [present({ kind: P.auth_disabled })],
      },
    ),
    row('login → the owner is checked first', IDLE, { kind: O.login_requested }, cli, {
      state: IDLE,
      effects: [{ kind: E.check_owner, purpose: OwnerPurpose.enum.login, origin: null }],
    }),
    row('logout → read the keychain, strictly', IDLE, { kind: O.logout_requested }, cli, {
      state: IDLE,
      effects: [{ kind: E.load_saved, purpose: LoadPurpose.enum.logout, tolerateUnreadable: false }],
    }),

    row('Ctrl-C while a request is open cancels the attempt', pending, { kind: O.interrupted }, cli, {
      state: { kind: S.cancelled },
      effects: [closePage, present({ kind: P.cancelled })],
    }),
    row('Ctrl-C with nothing open changes nothing', IDLE, { kind: O.interrupted }, cli, { state: IDLE, effects: [] }),

    row('close: a request is dropped and its page released', pending, { kind: O.closed }, stdio, {
      state: IDLE,
      effects: [closePage],
    }),
    row(
      'close: a saved credential stays; the request behind it goes',
      signedIn({}, request),
      { kind: O.closed },
      stdio,
      {
        state: signedIn(),
        effects: [closePage],
      },
    ),
    row('close: a memory-only credential is revoked', signedIn({ ephemeral: true }), { kind: O.closed }, stdio, {
      state: IDLE,
      effects: [closePage, { kind: E.revoke_credential, token: 'ftk_held', reason: RevokeReason.enum.close }],
    }),
    row('close: nothing held → just the page', IDLE, { kind: O.closed }, stdio, { state: IDLE, effects: [closePage] }),

    row(
      'an unexpected failure is "could not check", never a sign-out — whatever is held stays',
      signedIn(),
      { kind: O.errored },
      stdio,
      {
        state: signedIn(),
        effects: [present({ kind: P.cannot_verify })],
      },
    ),
  ];
  it.each(rows)('$name', ({ state, observation, config, expected }) => {
    expect(nextStep(state, observation, config)).toEqual(expected);
  });
});

describe('the shape every step keeps', () => {
  const states: SignInState[] = [
    IDLE,
    pending,
    signedIn(),
    signedIn({ ephemeral: true }),
    signedIn({}, request),
    { kind: S.denied },
    { kind: S.expired },
    { kind: S.cancelled },
    { kind: S.failed },
  ];
  const origins = ['http://127.0.0.1:1', null];
  const results = [ok, invalid, failure];
  const outcomes = [
    ...(['pending', 'denied', 'expired', 'invalid'] as const).map((kind) => ({ kind })),
    { kind: REDEEM_ERROR_KIND, error: 'busy' },
    { kind: 'signed_in', ...redeemedAs(SignInDuration.enum.session) },
    { kind: 'signed_in', ...redeemedAs(SignInDuration.enum['30d']) },
  ] as const;
  const observations: SignInObservation[] = [
    { kind: O.requested },
    { kind: O.ticked },
    { kind: O.login_requested },
    { kind: O.logout_requested },
    { kind: O.interrupted },
    { kind: O.closed },
    { kind: O.errored },
    ...Object.values(SOURCE).flatMap((source) => results.map((result) => checked(source, 'ftk_x', result))),
    ...Object.values(LoadPurpose.enum).flatMap((purpose) =>
      ['ftk_x', null].map((token) => ({ kind: O.saved_loaded, purpose, token }) as SignInObservation),
    ),
    ...Object.values(ClearNext.enum).map((next) => ({ kind: O.saved_cleared, next }) as SignInObservation),
    ...Object.values(OwnerPurpose.enum).flatMap((purpose) =>
      [true, false].flatMap((unclaimed) =>
        origins.map((origin) => ({ kind: O.owner_checked, purpose, unclaimed, origin }) as SignInObservation),
      ),
    ),
    ...origins.map((origin) => ({ kind: O.page_named, origin }) as SignInObservation),
    ...Object.values(PagePurpose.enum).flatMap((purpose) =>
      origins.map((origin) => ({ kind: O.page_opened, purpose, origin }) as SignInObservation),
    ),
    { kind: O.grant_started, deviceCode: 'd', userCode: 'ABCD-EFGH', origin: 'http://127.0.0.1:1' },
    { kind: O.grant_failed, error: 'boom' },
    ...Object.values(Continuation.enum).flatMap((then) => outcomes.map((result) => redeemed(then, result))),
    ...Object.values(Continuation.enum).flatMap((then) =>
      [true, false].map(
        (okSaved) =>
          ({ kind: O.saved, then, signedIn: redeemedAs(SignInDuration.enum['24h']), ok: okSaved }) as SignInObservation,
      ),
    ),
    ...Object.values(RevokeReason.enum).flatMap((reason) =>
      [true, false].map(
        (okRevoked) =>
          ({
            kind: O.revoked,
            reason,
            token: 'ftk_x',
            ok: okRevoked,
            error: okRevoked ? null : 'x',
          }) as SignInObservation,
      ),
    ),
  ];
  const configs = [stdio, stdioWithEnv, cli, { ...cli, authRequired: false }];

  const cases = states.flatMap((state) =>
    observations.flatMap((observation) => configs.map((config) => ({ state, observation, config }))),
  );

  it('answers every state × observation × channel, ending in at most one asking effect — the last', () => {
    expect(cases.length).toBeGreaterThan(1000);
    cases.forEach(({ state, observation, config }) => {
      const { effects } = nextStep(state, observation, config);
      const asking = effects.flatMap((effect, index) => (ASKING_EFFECT_KINDS.has(effect.kind) ? [index] : []));
      expect(asking.length, JSON.stringify({ state, observation })).toBeLessThanOrEqual(1);
      if (asking.length === 1) expect(asking[0]).toBe(effects.length - 1);
    });
  });

  it('classifies every effect kind as asking or telling, and nothing else', () => {
    const telling = [E.close_page, E.wait, E.present];
    expect([...ASKING_EFFECT_KINDS, ...telling].sort()).toEqual([...EffectKind.options].sort());
  });

  it('never hands the device code or a token to a presentation', () => {
    cases.forEach(({ state, observation, config }) => {
      nextStep(state, observation, config)
        .effects.flatMap((effect) => (effect.kind === E.present ? [effect.presentation] : []))
        .forEach((presentation) => {
          const text = JSON.stringify(presentation);
          expect(text).not.toContain('device-secret');
          expect(text).not.toContain('ftk_new');
        });
    });
  });
});

describe('pendingOf', () => {
  it('is the request a state has open, whether or not a credential is held', () => {
    expect(pendingOf(IDLE)).toBeNull();
    expect(pendingOf(pending)).toEqual(request);
    expect(pendingOf(signedIn())).toBeNull();
    expect(pendingOf(signedIn({}, request))).toEqual(request);
    expect(pendingOf({ kind: S.failed })).toBeNull();
  });
});
