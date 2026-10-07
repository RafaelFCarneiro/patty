import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { hostnameOfHostHeader, isLoopbackHost } from './common/net.js';
import { httpStatus, type AppError } from './common/errors.js';
import { authenticate, ownerNeedsSetup } from './controllers/auth.js';
import { declaredOrigin, isSameOrigin, isUnsafeMethod } from './logic/auth.js';
import { safeNextPath } from './wire/in/auth.js';
import { AuthMode, authErrors, OWNER_PRINCIPAL, type AuthError, type Principal } from './models/auth.js';
import { isPublicRoute, LOGIN_PATH, SEE_OTHER, SETUP_PATH, UI_ROOT_PATH } from './diplomat/http/authPaths.js';
import type { HttpAuth } from './diplomat/http/context.js';
import { readCookie, SESSION_COOKIE_NAME } from './diplomat/http/cookies.js';

/**
 * The auth hook (ADR-033 §1, §2, §6): composition-root wiring, deliberately outside `diplomat/*` — it
 * joins the HTTP edge (cookies, routes) to the auth controllers, and the edge must not depend on either.
 *
 * Registered on the root instance BEFORE any route, so it runs for every route including a request no
 * route matches. It resolves `req.principal`:
 *   - auth `disabled` (loopback)  → the owner, always;
 *   - auth `required`             → the session cookie's user; no session → 401 JSON (`/api`, `/mcp`,
 *     anything not under `/ui`) or a redirect to setup/login (`/ui`). Only `PUBLIC_ROUTES` skip this.
 * stdio never reaches this hook: it is trusted and acts as the owner too (`OWNER_PRINCIPAL`).
 */

const NEXT_PARAM = 'next';

const isUiPath = (path: string): boolean => path === UI_ROOT_PATH || path.startsWith(`${UI_ROOT_PATH}/`);
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

export const registerAuthGate = (app: FastifyInstance, auth: HttpAuth): void => {
  app.decorateRequest('principal', undefined);

  if (auth.mode === AuthMode.enum.disabled) {
    app.addHook('onRequest', async (req) => {
      req.principal = OWNER_PRINCIPAL;
    });
    return;
  }

  const { deps, runEffects, publicUrl } = auth;

  type Resolution = { principal: Principal | null } | { failure: AppError };

  const resolvePrincipal = async (req: FastifyRequest): Promise<Resolution> => {
    const token = readCookie(req.headers.cookie, SESSION_COOKIE_NAME);
    if (!token) return { principal: null };
    const result = await runEffects(() => authenticate(deps, deps.secrets.hashSecret(token)));
    return result.isOk() ? { principal: result.value } : { failure: result.error };
  };

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

    const resolved = await resolvePrincipal(req);
    if ('failure' in resolved) return reject(reply, resolved.failure);
    if (resolved.principal === null) return rejectUnauthenticated(req, reply);

    // Cookie-authenticated, so unsafe methods (including POST /mcp) must come from our own origin.
    const verdict = isUnsafeMethod(req.method) ? csrfVerdict(req, publicUrl) : null;
    if (verdict) return reject(reply, verdict);
    req.principal = resolved.principal;
    return undefined;
  });
};
