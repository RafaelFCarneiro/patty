import * as R from 'remeda';
import {
  CLIENT_GRANT_TTL_MS,
  DEFAULT_SIGN_IN_DURATION,
  GrantChannel,
  GrantStatus,
  MAX_SIGN_IN_DURATION_MS,
  RedeemPlanKind,
  SIGN_IN_DURATION_MS,
  SignInDuration,
  type ClientGrantEntity,
  type GrantChoice,
  type GrantRequest,
  type StartGrantInput,
} from '../../models/auth/grant.js';
import { Scope, WRITE_SCOPE } from '../../models/auth/scope.js';
import { SESSION_ONLY_LABEL, UNKNOWN_CLIENT_NAME } from '../../models/auth/signIn.js';
import { AccessTokenKind, TOKEN_NAME_MAX_LENGTH, TokenAccess } from '../../models/auth/token.js';
import { type InstanceSettingsEntity, type SignInCap } from '../../models/auth/users.js';
import { formatSetupCode, normalizeSetupCode } from './owner.js';
import { millis, toIso } from './time.js';

/** What a person typed vs. what was shown: a user code is normalized exactly like a setup code. */
export const normalizeUserCode = normalizeSetupCode;
/** `ABCDEFGH` → `ABCD-EFGH`. */
export const formatUserCode = formatSetupCode;

/** Absolute from approval, never from use, and never past the 30-day maximum. */
export const signInExpiry = (approvedAt: string, duration: SignInDuration): string =>
  toIso(millis(approvedAt) + Math.min(SIGN_IN_DURATION_MS[duration], MAX_SIGN_IN_DURATION_MS));

/** `session` lives in the stdio process's memory only; every other duration is saved to the keychain. */
export const persistsToKeychain = (duration: SignInDuration): boolean => duration !== SignInDuration.enum.session;

/** The longest sign-in this instance allows: the admin's setting (30 days until they change it). */
export const signInCapOf = (settings: InstanceSettingsEntity): SignInCap => settings.maxSignInDuration;

export const withinCap = (duration: SignInDuration, cap: SignInCap): boolean =>
  SIGN_IN_DURATION_MS[duration] <= SIGN_IN_DURATION_MS[cap];

/** A duration above the cap becomes the cap. Applied when a sign-in is approved; a granted one keeps its expiry. */
export const clampToCap = (duration: SignInDuration, cap: SignInCap): SignInDuration =>
  withinCap(duration, cap) ? duration : cap;

/** Whether this grant's asker may be handed a sign-in of this duration. */
export const durationAllowedFor = (channel: GrantChannel, duration: SignInDuration): boolean =>
  channel === GrantChannel.enum.stdio || duration !== SignInDuration.enum.session;

/** The durations the consent page offers this asker: what its channel may have, up to the instance cap. */
export const offeredDurations = (channel: GrantChannel, cap: SignInCap): SignInDuration[] =>
  R.filter(SignInDuration.options, (duration) => durationAllowedFor(channel, duration) && withinCap(duration, cap));

export const newGrant = (
  fields: { id: string; deviceCodeHash: string; userCode: string; input: StartGrantInput },
  now: Date,
): Omit<ClientGrantEntity, 'version'> => ({
  id: fields.id,
  deviceCodeHash: fields.deviceCodeHash,
  userCode: fields.userCode,
  clientName: fields.input.client.name,
  clientVersion: fields.input.client.version,
  profile: fields.input.profile,
  channel: fields.input.channel,
  hintAccess: fields.input.hint?.access ?? null,
  hintDuration: fields.input.hint?.duration ?? null,
  status: GrantStatus.enum.pending,
  userId: null,
  scopes: null,
  duration: null,
  createdAt: now.toISOString(),
  approvedAt: null,
  expiresAt: toIso(now.getTime() + CLIENT_GRANT_TTL_MS),
});

const isGrantExpired = (grant: ClientGrantEntity, now: Date): boolean => now.getTime() >= millis(grant.expiresAt);

/** A request still waiting for a person: pending and inside its window. */
export const isAnswerable = (grant: ClientGrantEntity | null, now: Date): grant is ClientGrantEntity =>
  grant !== null && grant.status === GrantStatus.enum.pending && !isGrantExpired(grant, now);

export const grantRequestOf = (grant: ClientGrantEntity): GrantRequest => ({
  userCode: formatUserCode(grant.userCode),
  clientName: grant.clientName,
  clientVersion: grant.clientVersion,
  profile: grant.profile,
  channel: grant.channel,
  createdAt: grant.createdAt,
  expiresAt: grant.expiresAt,
});

export const approvedGrant = (
  grant: ClientGrantEntity,
  fields: { userId: string; scopes: readonly Scope[]; duration: SignInDuration },
  now: Date,
): ClientGrantEntity => ({
  ...grant,
  status: GrantStatus.enum.approved,
  userId: fields.userId,
  scopes: [...fields.scopes],
  duration: fields.duration,
  approvedAt: now.toISOString(),
});

export const deniedGrant = (grant: ClientGrantEntity): ClientGrantEntity => ({
  ...grant,
  status: GrantStatus.enum.denied,
});

export const redeemedGrant = (grant: ClientGrantEntity): ClientGrantEntity => ({
  ...grant,
  status: GrantStatus.enum.redeemed,
});

export const expiredGrant = (grant: ClientGrantEntity): ClientGrantEntity => ({
  ...grant,
  status: GrantStatus.enum.expired,
});

/** What the consent form pre-selects: the asker's hint, else this user's last choice for this client, else the
 *  defaults (read-only, 24 hours), all within the instance cap. A hint of `session` is dropped for a grant that may not
 *  have one. */
export const consentChoice = (
  grant: ClientGrantEntity,
  last: Pick<ClientGrantEntity, 'scopes' | 'duration'> | null,
  cap: SignInCap,
): GrantChoice => {
  const lastAccess = last?.scopes
    ? last.scopes.includes(WRITE_SCOPE)
      ? TokenAccess.enum.write
      : TokenAccess.enum.read
    : undefined;
  const duration = R.pipe(
    [grant.hintDuration, last?.duration],
    R.filter(
      (candidate): candidate is SignInDuration => candidate != null && durationAllowedFor(grant.channel, candidate),
    ),
    R.first(),
  );
  return {
    access: grant.hintAccess ?? lastAccess ?? TokenAccess.enum.read,
    duration: clampToCap(duration ?? DEFAULT_SIGN_IN_DURATION, cap),
  };
};

/** What redeeming a device code means for this grant right now. `settle` is the expired row to write back, when
 *  the window has just run out on a grant that was still open. */
export type RedeemPlan =
  | { kind: typeof RedeemPlanKind.enum.invalid }
  | { kind: typeof RedeemPlanKind.enum.pending }
  | { kind: typeof RedeemPlanKind.enum.denied }
  | { kind: typeof RedeemPlanKind.enum.expired; settle: ClientGrantEntity | null }
  | {
      kind: typeof RedeemPlanKind.enum.mint;
      grant: ClientGrantEntity & { userId: string; scopes: Scope[]; duration: SignInDuration; approvedAt: string };
    };

export const redeemPlan = (grant: ClientGrantEntity | null, now: Date): RedeemPlan => {
  if (grant === null || grant.status === GrantStatus.enum.redeemed) return { kind: RedeemPlanKind.enum.invalid };
  if (grant.status === GrantStatus.enum.denied) return { kind: RedeemPlanKind.enum.denied };
  if (grant.status === GrantStatus.enum.expired) return { kind: RedeemPlanKind.enum.expired, settle: null };
  if (isGrantExpired(grant, now)) return { kind: RedeemPlanKind.enum.expired, settle: expiredGrant(grant) };
  if (grant.status === GrantStatus.enum.pending) return { kind: RedeemPlanKind.enum.pending };
  const { userId, scopes, duration, approvedAt } = grant;
  return userId !== null && scopes !== null && duration !== null && approvedAt !== null
    ? { kind: RedeemPlanKind.enum.mint, grant: { ...grant, userId, scopes, duration, approvedAt } }
    : { kind: RedeemPlanKind.enum.invalid };
};

/** The sign-in token a redeemed grant becomes. Its expiry is the approval time plus the chosen duration. */
export const newStdioSignIn = (
  fields: {
    id: string;
    tokenHash: string;
    prefix: string;
    grant: Extract<RedeemPlan, { kind: typeof RedeemPlanKind.enum.mint }>['grant'];
  },
  now: Date,
) => ({
  id: fields.id,
  userId: fields.grant.userId,
  kind: AccessTokenKind.enum.stdio,
  clientName: fields.grant.clientName,
  profile: fields.grant.profile,
  name: `${fields.grant.clientName} (${fields.grant.profile})`.slice(0, TOKEN_NAME_MAX_LENGTH),
  tokenHash: fields.tokenHash,
  prefix: fields.prefix,
  scopes: fields.grant.scopes,
  createdAt: now.toISOString(),
  lastUsedAt: null,
  expiresAt: signInExpiry(fields.grant.approvedAt, fields.grant.duration),
  revokedAt: null,
});

/** What the consent form remembers a redeemed grant under: one slot per user, profile and client. */
const consentMemoryKey = (grant: ClientGrantEntity): string =>
  JSON.stringify([grant.userId, grant.profile, grant.clientName]);

const newestApproval = (grants: readonly ClientGrantEntity[]): ClientGrantEntity | undefined =>
  R.firstBy(grants, [(grant) => grant.approvedAt ?? '', 'desc'], [(grant) => grant.id, 'desc']);

/**
 * The redeemed grants that no longer matter: every one except the newest approval per user, profile and client — that
 * one is the consent form's "last choice" (`lastRedeemed` picks it by the same rule). Pending and approved grants are
 * not candidates at all; the caller only ever offers redeemed ones.
 */
export const supersededGrants = (redeemed: readonly ClientGrantEntity[]): ClientGrantEntity[] =>
  R.pipe(
    redeemed,
    R.groupBy(consentMemoryKey),
    R.values(),
    R.filter(R.isDefined),
    R.flatMap((group) => {
      const kept = newestApproval(group);
      return group.filter((grant) => grant.id !== kept?.id);
    }),
  );

/** The label of the "this session only" duration for the client that is asking: "This Claude Desktop session only". */
export const sessionOnlyLabel = (clientName: string): string =>
  clientName === UNKNOWN_CLIENT_NAME ? SESSION_ONLY_LABEL.unnamed : SESSION_ONLY_LABEL.named(clientName);
