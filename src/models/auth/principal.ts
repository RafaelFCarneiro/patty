import { z } from 'zod';
import { Id } from '../id.js';
import { OWNER_USER_ID, UserRole } from './owner.js';
import { ALL_SCOPES, Scope } from './scope.js';

/** How a request authenticated, so the edge can tell a browser session from a bearer token from the trusted
 *  owner of an auth-disabled run, and a stdio sign-in (ADR-034) from either. */
export const PrincipalVia = z.enum(['session', 'token', 'owner', 'stdio']);
export type PrincipalVia = z.infer<typeof PrincipalVia>;

/** What a request acts as — resolved at the HTTP edge from the session or bearer token (or the owner, when
 *  auth is disabled or on stdio) and, from Phase 4, threaded into controllers as an explicit argument.
 *  A session and the owner hold every scope; a token holds the scopes it was minted with. */
export const PrincipalSchema = z.object({
  userId: Id,
  role: UserRole,
  scopes: z.array(Scope),
  via: PrincipalVia,
  /** The access token this request presented — only when `via` is `token`. */
  tokenId: Id.optional(),
});
export type Principal = z.infer<typeof PrincipalSchema>;

export const OWNER_PRINCIPAL: Principal = {
  userId: OWNER_USER_ID,
  role: UserRole.enum.admin,
  scopes: [...ALL_SCOPES],
  via: PrincipalVia.enum.owner,
};
