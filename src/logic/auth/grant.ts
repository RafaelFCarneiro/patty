import * as R from 'remeda';
import {
  CLIENT_GRANT_TTL_MS,
  DEFAULT_SIGN_IN_DURATION,
  GrantChannel,
  GrantStatus,
  INVALID_REDEEM,
  MAX_SIGN_IN_DURATION_MS,
  RedeemKind,
  RedeemPlanKind,
  SIGN_IN_DURATION_MS,
  SignInDuration,
  type ClientGrantEntity,
  type GrantChoice,
  type GrantRequest,
  type MintableGrant,
  type RedeemPlan,
  type RedeemResult,
  type StartGrantInput,
} from '../../models/auth/grant.js';
import type { Principal } from '../../models/auth/principal.js';
import { type Scope, WRITE_SCOPE } from '../../models/auth/scope.js';
import { SESSION_ONLY_LABEL, UNKNOWN_CLIENT_NAME } from '../../models/auth/signIn.js';
import {
  AccessTokenKind,
  TOKEN_NAME_MAX_LENGTH,
  TokenAccess,
  type AccessTokenEntity,
} from '../../models/auth/token.js';
import { type InstanceSettingsEntity, type SignInCap } from '../../models/auth/users.js';
import { formatSetupCode, normalizeSetupCode } from './owner.js';
import { millis, toIso } from './time.js';

export const normalizeUserCode = normalizeSetupCode;
export const formatUserCode = formatSetupCode;

export const signInExpiry = (approvedAt: string, duration: SignInDuration): string =>
  toIso(millis(approvedAt) + Math.min(SIGN_IN_DURATION_MS[duration], MAX_SIGN_IN_DURATION_MS));

export const persistsToKeychain = (duration: SignInDuration): boolean => duration !== SignInDuration.enum.session;

export const signInCapOf = (settings: InstanceSettingsEntity): SignInCap => settings.maxSignInDuration;

export const withinCap = (duration: SignInDuration, cap: SignInCap): boolean =>
  SIGN_IN_DURATION_MS[duration] <= SIGN_IN_DURATION_MS[cap];

export const clampToCap = (duration: SignInDuration, cap: SignInCap): SignInDuration =>
  withinCap(duration, cap) ? duration : cap;

export const durationAllowedFor = (channel: GrantChannel, duration: SignInDuration): boolean =>
  channel === GrantChannel.enum.stdio || duration !== SignInDuration.enum.session;

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

const closedPlan = (grant: ClientGrantEntity, now: Date): RedeemPlan | null => {
  if (grant.status === GrantStatus.enum.redeemed) return INVALID_REDEEM;
  if (grant.status === GrantStatus.enum.denied) return { kind: RedeemPlanKind.enum.denied };
  if (grant.status === GrantStatus.enum.expired) return { kind: RedeemPlanKind.enum.expired, settle: null };
  return isGrantExpired(grant, now) ? { kind: RedeemPlanKind.enum.expired, settle: expiredGrant(grant) } : null;
};

const openPlan = (grant: ClientGrantEntity): RedeemPlan => {
  if (grant.status === GrantStatus.enum.pending) return { kind: RedeemPlanKind.enum.pending };
  const { userId, scopes, duration, approvedAt } = grant;
  return userId !== null && scopes !== null && duration !== null && approvedAt !== null
    ? { kind: RedeemPlanKind.enum.mint, grant: { ...grant, userId, scopes, duration, approvedAt } }
    : INVALID_REDEEM;
};

export const redeemPlan = (grant: ClientGrantEntity | null, now: Date): RedeemPlan =>
  grant === null ? INVALID_REDEEM : (closedPlan(grant, now) ?? openPlan(grant));

export const signedIn = (
  token: string,
  entity: Pick<AccessTokenEntity, 'id' | 'scopes'> & { expiresAt: string },
  principal: Principal,
  duration: SignInDuration,
): RedeemResult => ({
  kind: RedeemKind.enum.signed_in,
  token,
  tokenId: entity.id,
  scopes: entity.scopes,
  principal,
  duration,
  expiresAt: entity.expiresAt,
});

export const newStdioSignIn = (
  fields: {
    id: string;
    tokenHash: string;
    prefix: string;
    grant: MintableGrant;
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

const consentMemoryKey = (grant: ClientGrantEntity): string =>
  JSON.stringify([grant.userId, grant.profile, grant.clientName]);

const newestApproval = (grants: readonly ClientGrantEntity[]): ClientGrantEntity | undefined =>
  R.firstBy(grants, [(grant) => grant.approvedAt ?? '', 'desc'], [(grant) => grant.id, 'desc']);

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

export const sessionOnlyLabel = (clientName: string): string =>
  clientName === UNKNOWN_CLIENT_NAME ? SESSION_ONLY_LABEL.unnamed : SESSION_ONLY_LABEL.named(clientName);
