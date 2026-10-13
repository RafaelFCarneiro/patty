import { z } from 'zod';
import { withPersistenceMeta } from '@rfc0/effect-runner';
import { Id } from '../id.js';
import { READ_SCOPE, Scope, WRITE_SCOPE } from './scope.js';
import type { SessionVerdict } from './session.js';

/** Every personal access token starts with this, so a leaked one is greppable (ADR-033 §3). */
export const TOKEN_PREFIX = 'ftk_';
/** How many characters of the random part are kept, in clear, to tell tokens apart in the list. */
export const TOKEN_DISPLAY_PREFIX_RANDOM_CHARS = 6;
export const TOKEN_NAME_MAX_LENGTH = 80;
/** The MCP `AuthInfo.clientId` of a request made with a personal access token: `pat:<token id>`. */
export const PAT_CLIENT_ID_PREFIX = 'pat:';

export const MAX_TOKEN_LENGTH = 256;

/** Expiry choices for a new token — there is no "never". A legacy row may still hold a null `expires_at`. */
export const TokenExpiry = z.enum(['30', '90', '365']);
export type TokenExpiry = z.infer<typeof TokenExpiry>;
/** What the token form preselects. */
export const DEFAULT_TOKEN_EXPIRY = TokenExpiry.enum['90'];
export const TOKEN_EXPIRY_DAYS: Readonly<Record<TokenExpiry, number>> = {
  '30': 30,
  '90': 90,
  '365': 365,
};

/** The two access levels the token form offers; `write` includes `read`. */
export const TokenAccess = z.enum(['read', 'write']);
export type TokenAccess = z.infer<typeof TokenAccess>;
export const TOKEN_ACCESS_SCOPES: Readonly<Record<TokenAccess, readonly Scope[]>> = {
  read: [READ_SCOPE],
  write: [READ_SCOPE, WRITE_SCOPE],
};

/** What minted an access token: a person at the token page (`pat`, ADR-033) or the stdio sign-in flow (`stdio`,
 *  ADR-034). Both are the same row, authenticated, listed and revoked the same way. */
export const AccessTokenKind = z.enum(['pat', 'stdio']);
export type AccessTokenKind = z.infer<typeof AccessTokenKind>;

/** A personal access token (ADR-033 §3) or a stdio sign-in (ADR-034 §3). Only `sha256(token)` and a display prefix
 *  are stored. */
export const AccessTokenEntitySchema = withPersistenceMeta(
  z.object({
    id: Id,
    userId: Id,
    kind: AccessTokenKind,
    /** The MCP client's self-reported name — a stdio sign-in only, `null` for a PAT. */
    clientName: z.string().nullable(),
    /** The `FINTRACK_PROFILE` this sign-in belongs to — a stdio sign-in only. */
    profile: z.string().nullable(),
    name: z.string().min(1).max(TOKEN_NAME_MAX_LENGTH),
    tokenHash: z.string().describe('sha256 of the token — the token itself is never stored'),
    prefix: z.string().describe('`ftk_` + the first characters of the random part, for display only'),
    scopes: z.array(Scope).min(1),
    createdAt: z.string(),
    lastUsedAt: z.string().nullable(),
    expiresAt: z.string().nullable(),
    revokedAt: z.string().nullable(),
  }),
);
export type AccessTokenEntity = z.infer<typeof AccessTokenEntitySchema>;

export const TokenStatus = z.enum(['active', 'expired', 'revoked']);
export type TokenStatus = z.infer<typeof TokenStatus>;

/** What the token list shows — everything but the hash. */
export type AccessTokenSummary = Omit<AccessTokenEntity, 'tokenHash' | 'version'> & { status: TokenStatus };

/** A freshly minted token — the plaintext is shown once and never stored or logged. */
export type CreatedAccessToken = { token: string; summary: AccessTokenSummary };

export type NewTokenSpec = { name: string; access: TokenAccess; expiry: TokenExpiry };

/** Creating a token asks for the login password again (step-up): a script that runs in the dashboard's origin
 *  holds the session cookie but not the password, so it cannot mint a token for itself. */
export type CreateTokenInput = NewTokenSpec & { password: string };

export type TokenVerdict = SessionVerdict;

/** A token's fields before it has been written (no `version` yet). */
export type TokenFields = Omit<AccessTokenEntity, 'version'>;
