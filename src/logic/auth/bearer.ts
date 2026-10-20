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
import type { ChallengeableError } from '../../models/auth/errors.js';
import { ALL_SCOPES, type Scope } from '../../models/auth/scope.js';
import { isTokenShaped } from './token.js';

export const credentialOf = (authorization: string | undefined): Credential => {
  if (authorization === undefined) return { kind: 'none' };
  const token = BEARER_HEADER.exec(authorization)?.[1];
  return token !== undefined && isTokenShaped(token) ? { kind: 'bearer', token } : { kind: 'malformed' };
};

export const acceptsBearer = (path: string): boolean =>
  [API_PATH_PREFIX, MCP_PATH].some((root) => path === root || path.startsWith(`${root}/`));

const quoted = (value: string): string => `"${value.replace(/["\\]/g, '\\$&')}"`;
const param = (name: string, value: string): string => `${name}=${quoted(value)}`;
const joinScopes = (scopes: readonly Scope[]): string => scopes.join(' ');

export const resourceMetadataUrl = (origin: string): string => `${origin}${MCP_PRM_PATH}`;

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

export const protectedResourceMetadata = (origin: string) => ({
  resource: `${origin}${MCP_PATH}`,
  scopes_supported: [...ALL_SCOPES],
  bearer_methods_supported: [BEARER_METHOD_HEADER],
  resource_name: RESOURCE_NAME,
});
