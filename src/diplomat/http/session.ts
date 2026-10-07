import type { FastifyRequest } from 'fastify';
import type { AppError } from '../../common/errors.js';
import { authenticate } from '../../controllers/auth.js';
import type { Principal } from '../../models/auth.js';
import type { AuthRoutesContext } from './context.js';
import { readCookie, SESSION_COOKIE_NAME } from './cookies.js';

/** `principal: null` = no (valid) session; `failure` = the lookup itself failed (e.g. a write conflict). */
export type Resolution = { principal: Principal | null } | { failure: AppError };

/** Who does this request's session cookie belong to? Slides, or deletes, the session as a side effect
 *  (`controllers/auth.ts`'s `authenticate`). Shared by the auth hook and long-lived streams that re-check. */
export const resolvePrincipal = async (auth: AuthRoutesContext, req: FastifyRequest): Promise<Resolution> => {
  const token = readCookie(req.headers.cookie, SESSION_COOKIE_NAME);
  if (!token) return { principal: null };
  const result = await auth.runEffects(() => authenticate(auth.deps, auth.deps.secrets.hashSecret(token)));
  return result.isOk() ? { principal: result.value } : { failure: result.error };
};
