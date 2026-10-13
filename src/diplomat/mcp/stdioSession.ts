import type { SignInInterpreter } from '../../controllers/deps.js';
import { notSignedInMessage } from '../../logic/auth/message.js';
import { pendingOf } from '../../logic/auth/signInFlow.js';
import { GrantChannel } from '../../models/auth/grant.js';
import { STDIO_MESSAGES } from '../../models/auth/message.js';
import { GRANT_POLL_INTERVAL_MS } from '../../models/auth/signIn.js';
import {
  IDLE,
  ObservationKind,
  PresentationKind,
  type Presentation,
  type SignInConfig,
  type SignInObservation,
  type SignInState,
} from '../../models/auth/signInFlow.js';
import { clientInfoOf } from '../../wire/in/auth.js';
import { GateKind, type GateOutcome } from './gate.js';

/**
 * The stdio channel's identity (ADR-034 §2, §4). A stdio process is spawned by whichever program the user pointed at
 * it, so it acts as nobody until it holds a credential, and it holds exactly one, found in this order:
 *   1. `FINTRACK_TOKEN` from the environment — a failure here is an error, never a reason to try the next source;
 *   2. the sign-in saved in the OS keychain for this profile and database;
 *   3. none: it asks for one (a pending grant the person approves in the browser) and answers every gated request
 *      with the instructions to do so.
 * The credential is re-validated on EVERY gated request through the same `authenticateToken` the HTTP edge uses, so a
 * revocation or an expiry takes effect on the very next call. This file only presents: every decision is
 * `logic/auth/signInFlow.ts`'s and every effect is the injected interpreter's. What it adds is the sequencing the
 * channel needs — one thing at a time, a poll timer while a request is open — and the words a stdio client reads.
 */
export type StdioSession = {
  /** Who the next gated request acts as — or why nobody. */
  resolve: () => Promise<GateOutcome>;
  /** Stop polling and, for a "this session only" sign-in, revoke it (best effort; the 12-hour cap covers a crash). */
  close: () => Promise<void>;
};

export type StdioSessionOptions = {
  signIn: SignInInterpreter;
  profile: string;
  envToken: string | undefined;
  /** What the MCP client reported in `initialize` (`undefined` before it has). */
  clientInfo: () => unknown;
};

const O = ObservationKind.enum;
const P = PresentationKind.enum;

const notSignedIn = (message: string): GateOutcome => ({ kind: GateKind.enum.not_signed_in, message });

/** The words a stdio client reads for what the protocol said. Nothing else is ever said to a stdio client. */
const outcomeOf = (presentation: Presentation | undefined): GateOutcome => {
  switch (presentation?.kind) {
    case P.granted:
      return { kind: GateKind.enum.granted, principal: presentation.principal };
    case P.invalid_env_token:
      return notSignedIn(STDIO_MESSAGES.invalidEnvToken);
    case P.instructions:
      return notSignedIn(
        notSignedInMessage({
          origin: presentation.origin,
          userCode: presentation.userCode,
          ownerUnclaimed: presentation.ownerUnclaimed,
        }),
      );
    default:
      return notSignedIn(STDIO_MESSAGES.cannotVerify);
  }
};

export const createStdioSession = (options: StdioSessionOptions): StdioSession => {
  const { signIn } = options;
  let state: SignInState = IDLE;
  let timer: NodeJS.Timeout | null = null;

  // Requests and the poll timer share the state, and a device code is single-use: one at a time.
  let queue: Promise<unknown> = Promise.resolve();
  const serially = <T>(work: () => Promise<T>): Promise<T> => {
    const next = queue.then(work);
    queue = next.catch(() => undefined);
    return next;
  };

  const config = (): SignInConfig => ({
    channel: GrantChannel.enum.stdio,
    profile: options.profile,
    client: clientInfoOf(options.clientInfo()),
    authRequired: true,
    envToken: options.envToken,
  });

  const stopPolling = (): void => {
    if (timer !== null) clearInterval(timer);
    timer = null;
  };

  const startPolling = (): void => {
    if (timer !== null) return;
    timer = setInterval(
      () => void serially(() => feed({ kind: O.ticked })).catch(() => undefined),
      GRANT_POLL_INTERVAL_MS,
    );
    timer.unref();
  };

  // The timer runs exactly while a request is open.
  const syncPolling = (): void => (pendingOf(state) === null ? stopPolling() : startPolling());

  /** Feed one observation; the last thing the protocol said (if anything) comes back. */
  const feed = async (observation: SignInObservation): Promise<Presentation | undefined> => {
    let said: Presentation | undefined;
    try {
      await signIn.drive(state, observation, config(), {
        present: (presentation) => void (said = presentation),
        // The timer paces a stdio session; there is nothing to wait for inline.
        wait: async () => undefined,
        progress: (next) => {
          state = next;
          syncPolling();
        },
      });
    } finally {
      syncPolling();
    }
    return said;
  };

  return {
    // An unexpected failure (the database is busy, the keychain misbehaves) is "could not check", never a sign-out.
    resolve: () =>
      serially(async () => outcomeOf(await feed({ kind: O.requested }).catch(() => feed({ kind: O.errored })))).catch(
        () => outcomeOf(undefined),
      ),

    close: () =>
      serially(async () => {
        stopPolling();
        await feed({ kind: O.closed });
      }).catch(() => undefined),
  };
};
