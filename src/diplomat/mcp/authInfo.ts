import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import { PAT_CLIENT_ID_PREFIX, type Principal } from '../../models/auth.js';

/**
 * The SDK's `AuthInfo` for a request's principal, handed to the transport as `req.raw.auth` and echoed back to
 * every tool as `extra.authInfo` (`scopes.ts` re-checks it). `token` is the access token's id — never the
 * secret, which this process only ever sees as a hash — and `clientId` names how the caller authenticated.
 */
export const authInfoOf = (principal: Principal): AuthInfo => ({
  token: principal.tokenId ?? principal.via,
  clientId: principal.tokenId === undefined ? principal.via : `${PAT_CLIENT_ID_PREFIX}${principal.tokenId}`,
  scopes: principal.scopes,
  extra: { userId: principal.userId },
});
