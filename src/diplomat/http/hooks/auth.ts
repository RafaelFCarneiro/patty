import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { httpStatus, type AppError } from '../../../common/errors.js';
import { ownerNeedsSetup } from '../../../controllers/auth.js';
import { csrfVerdict, isLoopbackRequest, preSessionCsrfVerdict, type CsrfRequest } from '../../../logic/auth.js';
import { AuthMode, authErrors, isUiPath, OWNER_PRINCIPAL } from '../../../models/auth.js';
import { safeNextPath } from '../../../wire/in/auth.js';
import { isPublicRoute, LOGIN_PATH, SEE_OTHER, SETUP_PATH } from '../authPaths.js';
import type { HttpAuth } from '../context.js';
import { resolvePrincipal } from '../session.js';

/**
 * The auth hook (ADR-033 §1, §2, §6): an inbound-edge request interceptor — read the headers, route pattern and
 * session cookie, ask `logic/auth.ts` and `controllers/auth.ts` for the decision, translate it to 401 / 403 /
 * redirect / `req.principal`. No policy lives here; `server.ts` registers it on the root instance BEFORE any
 * route (ordering is wiring), so it also guards a request no route matches.
 *   - auth `disabled` (loopback)  → the owner — but only for a request that names a loopback `Host` (and
 *     `Origin`, if sent): anything else is a DNS-rebound or cross-site page and gets 403 on every route;
 *   - auth `required`             → the session cookie's user; no session → 401 JSON (`/api`, `/mcp`,
 *     anything not under `/ui`) or a redirect to setup/login (`/ui`). Only `PUBLIC_ROUTES` skip this.
 * stdio never reaches this hook: it is trusted and acts as the owner too (`OWNER_PRINCIPAL`).
 */

const NEXT_PARAM = 'next';

const pathOf = (url: string): string => url.split('?')[0] ?? url;

const isLoginOrSetup = (path: string): boolean => path === LOGIN_PATH || path === SETUP_PATH;

const csrfInput = (req: FastifyRequest, publicUrl: string | undefined): CsrfRequest => ({
  method: req.method,
  publicUrl,
  host: req.headers.host,
  origin: req.headers.origin,
  referer: req.headers.referer,
});

const reject = (reply: FastifyReply, error: AppError): FastifyReply => reply.status(httpStatus(error)).send({ error });

const loginRedirectTarget = (req: FastifyRequest): string => {
  const next = safeNextPath(req.url);
  return next === req.url && !isLoginOrSetup(pathOf(next))
    ? `${LOGIN_PATH}?${NEXT_PARAM}=${encodeURIComponent(next)}`
    : LOGIN_PATH;
};

export const registerAuthHook = (app: FastifyInstance, auth: HttpAuth): void => {
  app.decorateRequest('principal', undefined);

  if (auth.mode === AuthMode.enum.disabled) {
    app.addHook('onRequest', async (req, reply) => {
      // Never echo the offending header back: the hint is a constant.
      if (!isLoopbackRequest({ host: req.headers.host, origin: req.headers.origin })) {
        return reject(reply, authErrors.nonLoopbackRequest);
      }
      req.principal = OWNER_PRINCIPAL;
      return undefined;
    });
    return;
  }

  const { deps, publicUrl } = auth;

  const rejectUnauthenticated = async (req: FastifyRequest, reply: FastifyReply): Promise<FastifyReply> => {
    if (!isUiPath(pathOf(req.url))) return reject(reply, authErrors.unauthenticated);
    const target = (await ownerNeedsSetup(deps)) ? SETUP_PATH : loginRedirectTarget(req);
    return reply.redirect(target, SEE_OTHER);
  };

  app.addHook('onRequest', async (req, reply) => {
    if (isPublicRoute(req.routeOptions.url, req.method)) {
      const verdict = preSessionCsrfVerdict(csrfInput(req, publicUrl));
      return verdict ? reject(reply, verdict) : undefined;
    }

    const resolved = await resolvePrincipal(auth, req);
    if ('failure' in resolved) return reject(reply, resolved.failure);
    if (resolved.principal === null) return rejectUnauthenticated(req, reply);

    // Cookie-authenticated, so unsafe methods (including POST /mcp) must come from our own origin.
    const verdict = csrfVerdict(csrfInput(req, publicUrl));
    if (verdict) return reject(reply, verdict);
    req.principal = resolved.principal;
    return undefined;
  });
};
