import type { UserEntity } from '../../models/auth/owner.js';
import { PrincipalVia, type Principal } from '../../models/auth/principal.js';
import { SESSION_TOUCH_INTERVAL_MS } from '../../models/auth/session.js';
import { DAY_MS } from '../../models/auth/time.js';
import {
  AccessTokenKind,
  MAX_TOKEN_LENGTH,
  TOKEN_ACCESS_SCOPES,
  TOKEN_DISPLAY_PREFIX_RANDOM_CHARS,
  TOKEN_EXPIRY_DAYS,
  TOKEN_PREFIX,
  TokenStatus,
  type AccessTokenEntity,
  type AccessTokenSummary,
  type NewTokenSpec,
  type TokenFields,
  type TokenVerdict,
} from '../../models/auth/token.js';
import { hasCredentials } from './owner.js';
import { millis, toIso } from './time.js';

export const tokenDisplayPrefix = (token: string): string =>
  token.slice(0, TOKEN_PREFIX.length + TOKEN_DISPLAY_PREFIX_RANDOM_CHARS);

export const newAccessToken = (
  fields: { id: string; userId: string; tokenHash: string; prefix: string; input: NewTokenSpec },
  now: Date,
) => {
  const days = TOKEN_EXPIRY_DAYS[fields.input.expiry];
  return {
    id: fields.id,
    userId: fields.userId,
    name: fields.input.name,
    tokenHash: fields.tokenHash,
    prefix: fields.prefix,
    scopes: [...TOKEN_ACCESS_SCOPES[fields.input.access]],
    kind: AccessTokenKind.enum.pat,
    clientName: null,
    profile: null,
    createdAt: now.toISOString(),
    lastUsedAt: null,
    expiresAt: toIso(now.getTime() + days * DAY_MS),
    revokedAt: null,
  };
};

export const tokenStatus = (token: TokenFields, now: Date): TokenStatus =>
  token.revokedAt !== null
    ? TokenStatus.enum.revoked
    : token.expiresAt !== null && now.getTime() >= millis(token.expiresAt)
      ? TokenStatus.enum.expired
      : TokenStatus.enum.active;

export const isLiveToken =
  (now: Date) =>
  (token: TokenFields): boolean =>
    tokenStatus(token, now) === TokenStatus.enum.active;

export const summarizeToken = (token: TokenFields, now: Date): AccessTokenSummary => ({
  id: token.id,
  userId: token.userId,
  name: token.name,
  prefix: token.prefix,
  scopes: token.scopes,
  kind: token.kind,
  clientName: token.clientName,
  profile: token.profile,
  createdAt: token.createdAt,
  lastUsedAt: token.lastUsedAt,
  expiresAt: token.expiresAt,
  revokedAt: token.revokedAt,
  status: tokenStatus(token, now),
});

export const tokenAdmitsVia = (token: Pick<AccessTokenEntity, 'kind'>, via: PrincipalVia): boolean =>
  token.kind === AccessTokenKind.enum.pat || via === PrincipalVia.enum.stdio;

export const evaluateToken = (
  token: AccessTokenEntity | null,
  user: UserEntity | null,
  now: Date,
  via: PrincipalVia = PrincipalVia.enum.token,
): TokenVerdict =>
  token === null ||
  !tokenAdmitsVia(token, via) ||
  tokenStatus(token, now) !== TokenStatus.enum.active ||
  user === null ||
  !hasCredentials(user) ||
  user.disabledAt !== null
    ? { kind: 'invalid' }
    : {
        kind: 'valid',
        touch: token.lastUsedAt === null || now.getTime() - millis(token.lastUsedAt) >= SESSION_TOUCH_INTERVAL_MS,
      };

export const usedToken = (token: AccessTokenEntity, now: Date): AccessTokenEntity => ({
  ...token,
  lastUsedAt: now.toISOString(),
});

export const revokedToken = (token: AccessTokenEntity, now: Date): AccessTokenEntity => ({
  ...token,
  revokedAt: now.toISOString(),
});

export const tokenPrincipal = (
  token: Pick<AccessTokenEntity, 'id' | 'scopes'>,
  user: UserEntity,
  via: PrincipalVia = PrincipalVia.enum.token,
): Principal => ({
  userId: user.id,
  role: user.role,
  scopes: token.scopes,
  via,
  tokenId: token.id,
});

export const isTokenShaped = (raw: string): boolean => raw.startsWith(TOKEN_PREFIX) && raw.length <= MAX_TOKEN_LENGTH;
