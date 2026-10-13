import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import { PAT_CLIENT_ID_PREFIX, PrincipalSchema, type Principal } from '../../models/auth.js';

/**
 * The SDK's `AuthInfo` for a request's principal, handed to the transport as `req.raw.auth` and echoed back to
 * every tool as `extra.authInfo` (the gate reads it). `token` is the access token's id — never the secret, which this
 * process only ever sees as a hash — and `clientId` names how the caller authenticated. `extra` carries the rest of the
 * principal, so `principalOf` can rebuild it whole.
 */
export const authInfoOf = (principal: Principal): AuthInfo => ({
  token: principal.tokenId ?? principal.via,
  clientId: principal.tokenId === undefined ? principal.via : `${PAT_CLIENT_ID_PREFIX}${principal.tokenId}`,
  scopes: principal.scopes,
  extra: { userId: principal.userId, role: principal.role, via: principal.via, tokenId: principal.tokenId },
});

/** The inverse of `authInfoOf`, decoded at this boundary: `null` for anything that is not a whole principal, so a
 *  malformed `authInfo` is refused rather than trusted. */
export const principalOf = (authInfo: Pick<AuthInfo, 'scopes' | 'extra'>): Principal | null => {
  const decoded = PrincipalSchema.safeParse({ ...authInfo.extra, scopes: authInfo.scopes });
  return decoded.success ? decoded.data : null;
};
