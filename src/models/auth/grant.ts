import { z } from 'zod';
import { withPersistenceMeta } from '@rfc0/effect-runner';
import { Id } from '../id.js';
import type { Principal } from './principal.js';
import { Scope } from './scope.js';
import { CLIENT_NAME_MAX_LENGTH, CLIENT_VERSION_MAX_LENGTH, ProfileSchema } from './signIn.js';
import { DAY_MS, HOUR_MS, MINUTE_MS } from './time.js';
import { TokenAccess } from './token.js';

/** How long a stdio sign-in lasts, chosen by the person who approves it. `session` is kept in the stdio process's
 *  memory only and never reaches the keychain; the others are saved. Counted absolutely from approval — use never
 *  extends it. */
export const SignInDuration = z.enum(['session', '24h', '7d', '30d']);
export type SignInDuration = z.infer<typeof SignInDuration>;
/** `fintrack login` runs in a shell that exits, so it has no "this session" to tie a sign-in to. */
export const LoginDuration = SignInDuration.exclude([SignInDuration.enum.session]);
export type LoginDuration = z.infer<typeof LoginDuration>;
export const DEFAULT_SIGN_IN_DURATION = SignInDuration.enum['24h'];
/** A "this session only" sign-in is revoked when its process exits; this cap covers a process that died instead. */
export const SESSION_SIGN_IN_CAP_MS = 12 * HOUR_MS;
export const SIGN_IN_DURATION_MS: Readonly<Record<SignInDuration, number>> = {
  session: SESSION_SIGN_IN_CAP_MS,
  '24h': DAY_MS,
  '7d': 7 * DAY_MS,
  '30d': 30 * DAY_MS,
};
/** The longest any sign-in may last (an admin may lower it after ADR-033 Phase 4, never raise it). */
export const MAX_SIGN_IN_DURATION_MS = SIGN_IN_DURATION_MS['30d'];

/** The device-style grant: the stdio process (or `fintrack login`) asks, a person approves in the browser. */
export const GrantStatus = z.enum(['pending', 'approved', 'denied', 'redeemed', 'expired']);
export type GrantStatus = z.infer<typeof GrantStatus>;
/** Who asked: an MCP client over stdio, or `fintrack login` in a shell. Decides whether `session` is offered. */
export const GrantChannel = z.enum(['stdio', 'cli']);
export type GrantChannel = z.infer<typeof GrantChannel>;

export const CLIENT_GRANT_TTL_MS = 10 * MINUTE_MS;

/** A user code is 8 Crockford base32 symbols (40 bits), shown `XXXX-XXXX`. */
export const USER_CODE_LENGTH = 8;
/** A fresh user code colliding with a still-pending one is astronomically unlikely; this bounds the retry anyway. */
export const USER_CODE_ATTEMPTS = 5;

export const ClientGrantEntitySchema = withPersistenceMeta(
  z.object({
    id: Id,
    deviceCodeHash: z.string().describe('sha256 of the device code — the code itself lives only in the asking process'),
    userCode: z.string().describe('Normalized (no dash, upper-case); shown as XXXX-XXXX'),
    clientName: z.string().max(CLIENT_NAME_MAX_LENGTH),
    clientVersion: z.string().max(CLIENT_VERSION_MAX_LENGTH),
    profile: ProfileSchema,
    channel: GrantChannel,
    /** What the asker would like pre-selected on the consent page (`fintrack login --scope/--duration`). */
    hintAccess: TokenAccess.nullable(),
    hintDuration: SignInDuration.nullable(),
    status: GrantStatus,
    userId: Id.nullable().describe('The user who approved — null until approved'),
    scopes: z.array(Scope).min(1).nullable(),
    duration: SignInDuration.nullable(),
    createdAt: z.string(),
    approvedAt: z.string().nullable(),
    expiresAt: z.string(),
  }),
);
export type ClientGrantEntity = z.infer<typeof ClientGrantEntitySchema>;

/** Who is asking, as the asking process reports it — shown to the approver as "reported by the client". */
export type ClientInfo = { name: string; version: string };

export type StartGrantInput = {
  client: ClientInfo;
  profile: string;
  channel: GrantChannel;
  hint?: { access?: TokenAccess; duration?: SignInDuration };
};

/** The device code is returned once, to the process that asked, and never stored. */
export type StartedGrant = { deviceCode: string; userCode: string; expiresAt: string };

/** What the consent page shows about a pending request. */
export type GrantRequest = {
  userCode: string;
  clientName: string;
  clientVersion: string;
  profile: string;
  channel: GrantChannel;
  createdAt: string;
  expiresAt: string;
};

/** The consent form's pre-selection: the asker's hint, else what this user chose last time, else the defaults. */
export type GrantChoice = { access: TokenAccess; duration: SignInDuration };

export type ApproveGrantInput = { userCode: string } & GrantChoice;

export type SignedIn = {
  token: string;
  tokenId: string;
  scopes: Scope[];
  /** Who the new sign-in acts as — what the stdio gate hands every handler. */
  principal: Principal;
  duration: SignInDuration;
  expiresAt: string;
};

/** What redeeming a device code answers. Only `signed_in` carries the (one-time) plaintext token. */
export const RedeemKind = z.enum(['pending', 'denied', 'expired', 'invalid', 'signed_in']);
export type RedeemKind = z.infer<typeof RedeemKind>;
export type RedeemResult =
  | { kind: Exclude<RedeemKind, typeof RedeemKind.enum.signed_in> }
  | ({ kind: typeof RedeemKind.enum.signed_in } & SignedIn);

/** What `logic/auth.ts`'s `redeemPlan` decides before anything is written: the four non-minting answers, or `mint`. */
export const RedeemPlanKind = z.enum(['pending', 'denied', 'expired', 'invalid', 'mint']);
export type RedeemPlanKind = z.infer<typeof RedeemPlanKind>;
