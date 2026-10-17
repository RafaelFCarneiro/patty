import type { FastifyReply, FastifyRequest } from 'fastify';
import type { AppError } from '../../common/errors.js';
import { authenticate } from '../../controllers/auth.js';
import { authenticateToken } from '../../controllers/accessTokens.js';
import { authErrors } from '../../models/auth/errors.js';
import { UserRole } from '../../models/auth/owner.js';
import { type Principal, PrincipalVia } from '../../models/auth/principal.js';
import type { AuthRoutesContext } from './context.js';
import { readCookie, SESSION_COOKIE_NAME } from './cookies.js';
import { replyError } from './respond.js';

/** `principal: null` = no (valid) credential; `failure` = the lookup itself failed (e.g. a write conflict). */
export type Resolution = { principal: Principal | null } | { failure: AppError };

/** Who does this request's session cookie belong to? Slides, or deletes, the session as a side effect
 *  (`controllers/auth.ts`'s `authenticate`). Shared by the auth hook and long-lived streams that re-check. */
export const resolvePrincipal = async (auth: AuthRoutesContext, req: FastifyRequest): Promise<Resolution> => {
  const token = readCookie(req.headers.cookie, SESSION_COOKIE_NAME);
  if (!token) return { principal: null };
  const result = await auth.runEffects(() => authenticate(auth.deps, auth.deps.secrets.hashSecret(token)));
  return result.isOk() ? { principal: result.value } : { failure: result.error };
};

/** Whose personal access token is this? `null` for an unknown, revoked or expired one
 *  (`controllers/accessTokens.ts`'s `authenticateToken`; `last_used_at` is touched at most every few minutes). */
export const resolveBearerPrincipal = async (auth: AuthRoutesContext, token: string): Promise<Resolution> => {
  const result = await auth.runEffects(() => authenticateToken(auth.deps, auth.deps.secrets.hashSecret(token)));
  return result.isOk() ? { principal: result.value } : { failure: result.error };
};

/** The hook only authenticates a bearer on /api and /mcp, so a token should never reach a browser page — but "a token
 *  can never mint, widen or approve anything" is too important to rest on path routing alone, so each page that
 *  grants access also insists on a browser session. */
export const requireSession = async (req: FastifyRequest, reply: FastifyReply): Promise<FastifyReply | undefined> =>
  req.principal?.via === PrincipalVia.enum.session ? undefined : replyError(reply, authErrors.sessionRequired);

/** User management is for administrators. Anyone else — a member — gets the answer for a page that does not exist
 *  (Fastify's own not-found reply), not a 403 that would reveal it is there. */
export const requireAdmin = async (req: FastifyRequest, reply: FastifyReply): Promise<FastifyReply | undefined> => {
  if (req.principal?.role === UserRole.enum.admin) return undefined;
  reply.callNotFound();
  return reply;
};
