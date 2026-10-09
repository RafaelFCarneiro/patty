import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { hostnameOfHostHeader, isLoopbackHost } from '../../../common/net.js';
import { httpStatus, type AppError } from '../../../common/errors.js';
import { ownerNeedsSetup } from '../../../controllers/auth.js';
import { declaredOrigin, isLoopbackRequest, isSameOrigin, isUnsafeMethod } from '../../../logic/auth.js';
import { safeNextPath } from '../../../wire/in/auth.js';
import { AuthMode, authErrors, isUiPath, OWNER_PRINCIPAL, type AuthError } from '../../../models/auth.js';
import { isPublicRoute, LOGIN_PATH, SEE_OTHER, SETUP_PATH } from '../authPaths.js';
import type { HttpAuth } from '../context.js';
import { resolvePrincipal } from '../session.js';

/**
 * The auth hook (ADR-033 §1, §2, §6): composition-root wiring, deliberately outside `diplomat/*` — it
 * joins the HTTP edge (cookies, routes) to the auth controllers, and the edge must not depend on either.
 *
 * Registered on the root instance BEFORE any route, so it runs for every route including a request no
 * route matches. It resolves `req.principal`:
 *   - auth `disabled` (loopback)  → the owner — but only for a request that names a loopback `Host` (and
 *     `Origin`, if sent): anything else is a DNS-rebound or cross-site page and gets 403 on every route;
 *   - auth `required`             → the session cookie's user; no session → 401 JSON (`/api`, `/mcp`,
 *     anything not under `/ui`) or a redirect to setup/login (`/ui`). Only `PUBLIC_ROUTES` skip this.
 * stdio never reaches this hook: it is trusted and acts as the owner too (`OWNER_PRINCIPAL`).
 */

const NEXT_PARAM = 'next';

const pathOf = (url: string): string => url.split('?')[0] ?? url;

/** Origins a browser may legitimately send for this request: `PUBLIC_URL`, plus — when the request itself
 *  arrived at a loopback host — that host's own origin (a local operator reaching a container through its
 *  loopback port publish). Never derived from a non-loopback `Host`, which a rebinding attacker controls. */
export const allowedOrigins = (publicUrl: string | undefined, hostHeader: string | undefined): string[] => {
  const hostname = hostHeader === undefined ? null : hostnameOfHostHeader(hostHeader);
  const ownLoopbackOrigin =
    hostHeader !== undefined && hostname !== null && isLoopbackHost(hostname) ? [`http://${hostHeader}`] : [];
  return [...(publicUrl === undefined ? [] : [publicUrl]), ...ownLoopbackOrigin];
};

const csrfVerdict = (req: FastifyRequest, publicUrl: string | undefined): AuthError | null => {
  const allowed = allowedOrigins(publicUrl, req.headers.host);
  if (allowed.length === 0) return authErrors.unknownOrigin;
  const declared = declaredOrigin(req.headers.origin, req.headers.referer);
  return allowed.some((origin) => isSameOrigin(origin, declared)) ? null : authErrors.crossOrigin;
};

const reject = (reply: FastifyReply, error: AppError): FastifyReply => reply.status(httpStatus(error)).send({ error });

const loginRedirectTarget = (req: FastifyRequest): string => {
  const next = safeNextPath(req.url);
  return next === req.url && !isLoginOrSetup(pathOf(next))
    ? `${LOGIN_PATH}?${NEXT_PARAM}=${encodeURIComponent(next)}`
    : LOGIN_PATH;
};

const isLoginOrSetup = (path: string): boolean => path === LOGIN_PATH || path === SETUP_PATH;

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
    // Pre-session POSTs (login, setup) carry no ambient credential to forge, but a forced-login attack is
    // still a cross-site POST — so a browser that declares an origin must declare ours. A client that
    // declares none (curl, scripts) has no browser to defend.
    if (isPublicRoute(req.routeOptions.url, req.method)) {
      const declaresOrigin = req.headers.origin !== undefined || req.headers.referer !== undefined;
      const verdict = isUnsafeMethod(req.method) && declaresOrigin ? csrfVerdict(req, publicUrl) : null;
      return verdict ? reject(reply, verdict) : undefined;
    }

    const resolved = await resolvePrincipal(auth, req);
    if ('failure' in resolved) return reject(reply, resolved.failure);
    if (resolved.principal === null) return rejectUnauthenticated(req, reply);

    // Cookie-authenticated, so unsafe methods (including POST /mcp) must come from our own origin.
    const verdict = isUnsafeMethod(req.method) ? csrfVerdict(req, publicUrl) : null;
    if (verdict) return reject(reply, verdict);
    req.principal = resolved.principal;
    return undefined;
  });
};
