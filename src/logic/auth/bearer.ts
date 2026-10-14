import {
  API_PATH_PREFIX,
  BEARER_HEADER,
  BEARER_METHOD_HEADER,
  BEARER_SCHEME,
  MCP_PATH,
  MCP_PRM_PATH,
  RESOURCE_NAME,
  type Credential,
} from '../../models/auth/bearer.js';
import { type ChallengeableError } from '../../models/auth/errors.js';
import { ALL_SCOPES, Scope } from '../../models/auth/scope.js';
import { isTokenShaped } from './token.js';

/** The `Authorization` header is authoritative when present: it must be `Bearer ftk_…`. Anything else
 *  (another scheme, no token, a token that is not ours) is `malformed` — never a reason to try the cookie. */
export const credentialOf = (authorization: string | undefined): Credential => {
  if (authorization === undefined) return { kind: 'none' };
  const token = BEARER_HEADER.exec(authorization)?.[1];
  return token !== undefined && isTokenShaped(token) ? { kind: 'bearer', token } : { kind: 'malformed' };
};

/** Only `/api` and `/mcp` take a bearer token; `/ui` is the browser surface and stays session-only. */
export const acceptsBearer = (path: string): boolean =>
  [API_PATH_PREFIX, MCP_PATH].some((root) => path === root || path.startsWith(`${root}/`));

const quoted = (value: string): string => `"${value.replace(/["\\]/g, '\\$&')}"`;
const param = (name: string, value: string): string => `${name}=${quoted(value)}`;
const joinScopes = (scopes: readonly Scope[]): string => scopes.join(' ');

export const resourceMetadataUrl = (origin: string): string => `${origin}${MCP_PRM_PATH}`;

/**
 * The one place a `WWW-Authenticate` value is built.
 *   - no credential        → `resource_metadata` + every scope (what a client should request);
 *   - invalid/expired token → `error="invalid_token"` + `resource_metadata`;
 *   - too little scope      → `error="insufficient_scope"` + the scope that was needed + `resource_metadata`.
 * `resource_metadata` is left out when the instance cannot name its own origin.
 */
export const bearerChallenge = (error: ChallengeableError, metadataUrl: string | null): string => {
  const metadata = metadataUrl === null ? [] : [param('resource_metadata', metadataUrl)];
  switch (error.code) {
    case 'unauthenticated':
      return `${BEARER_SCHEME} ${[...metadata, param('scope', joinScopes(ALL_SCOPES))].join(', ')}`;
    case 'invalid_token':
      return `${BEARER_SCHEME} ${[param('error', error.code), ...metadata].join(', ')}`;
    case 'insufficient_scope':
      return `${BEARER_SCHEME} ${[param('error', error.code), param('scope', error.scope), ...metadata].join(', ')}`;
    default: {
      const _exhaustive: never = error;
      throw new Error(`unmapped challenge: ${JSON.stringify(_exhaustive)}`);
    }
  }
};

/**
 * The metadata document for resource `<origin>/mcp`. `authorization_servers` is OPTIONAL in RFC 9728 and is
 * omitted until the in-process authorization server exists (ADR-033 Phase 3); `offline_access` is never listed
 * (MCP authorization: refresh tokens are not a resource requirement).
 */
export const protectedResourceMetadata = (origin: string) => ({
  resource: `${origin}${MCP_PATH}`,
  scopes_supported: [...ALL_SCOPES],
  bearer_methods_supported: [BEARER_METHOD_HEADER],
  resource_name: RESOURCE_NAME,
});
