import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { startsAtSetup } from '../../../controllers/auth/owner.js';
import { acceptsBearer, credentialOf } from '../../../logic/auth/bearer.js';
import { csrfVerdict, isLoopbackRequest, preSessionCsrfVerdict } from '../../../logic/auth/origin.js';
import { defaultScopeForMethod, hasScope } from '../../../logic/auth/scope.js';
import { authErrors } from '../../../models/auth/errors.js';
import { AuthMode } from '../../../models/auth/mode.js';
import { type CsrfRequest, isUiPath } from '../../../models/auth/origin.js';
import { OWNER_PRINCIPAL, type Principal } from '../../../models/auth/principal.js';
import { safeNextPath } from '../../../wire/in/auth.js';
import { isPublicRoute, LOGIN_PATH, SEE_OTHER, SETUP_PATH } from '../auth-paths.js';
import type { HttpAuth } from '../context.js';
import { rejectWithChallenge } from '../bearer.js';
import { replyError as reject } from '../respond.js';
import { resolveBearerPrincipal, resolvePrincipal, type Resolution } from '../session.js';

/**
 * The auth hook (ADR-033 §1, §2, §6): an inbound-edge request interceptor — read the headers, route pattern and
 * session cookie, ask `logic/auth/` and `controllers/auth.ts` for the decision, translate it to 401 / 403 /
 * redirect / `req.principal`. No policy lives here; `composition/http.ts` registers it on the root instance BEFORE any
 * route (ordering is wiring), so it also guards a request no route matches.
 *   - auth `disabled` (loopback)  → the owner — but only for a request that names a loopback `Host` (and
 *     `Origin`, if sent): anything else is a DNS-rebound or cross-site page and gets 403 on every route;
 *   - auth `required`             → on `/api` and `/mcp` an `Authorization` header is AUTHORITATIVE: it must be
 *     `Bearer ftk_…` and valid, and the cookie is then ignored — a bad bearer never falls back to a session, and a
 *     bearer request carries no ambient credential, so it skips the CSRF check. Otherwise (no header, or a `/ui`
 *     path, where a bearer is never accepted) the session cookie's user. No credential → 401 + a Bearer challenge
 *     (anything not under `/ui`) or a redirect to setup/login (`/ui`). The principal's scopes are then checked
 *     against the matched route's declared scope. Only `PUBLIC_ROUTES` skip all of this.
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

const loginRedirectTarget = (req: FastifyRequest): string => {
  const next = safeNextPath(req.url);
  return next === req.url && !isLoginOrSetup(pathOf(next))
    ? `${LOGIN_PATH}?${NEXT_PARAM}=${encodeURIComponent(next)}`
    : LOGIN_PATH;
};

type RequiredAuth = Extract<HttpAuth, { mode: typeof AuthMode.enum.required }>;

const admitOwnerOnLoopback = async (req: FastifyRequest, reply: FastifyReply) => {
  // Never echo the offending header back: the hint is a constant.
  if (!isLoopbackRequest({ host: req.headers.host, origin: req.headers.origin })) {
    return reject(reply, authErrors.nonLoopbackRequest);
  }
  req.principal = OWNER_PRINCIPAL;
  return undefined;
};

const rejectUnauthenticated = async (auth: RequiredAuth, req: FastifyRequest, reply: FastifyReply) => {
  if (!isUiPath(pathOf(req.url))) return rejectWithChallenge(req, reply, auth.publicUrl, authErrors.unauthenticated);
  const target = (await startsAtSetup(auth.deps)) ? SETUP_PATH : loginRedirectTarget(req);
  return reply.redirect(target, SEE_OTHER);
};

// A route's declared scope (RouteDefinition.scope); a route that declares none falls back to the method rule.
const requiredScope = (req: FastifyRequest) => req.routeOptions.config?.scope ?? defaultScopeForMethod(req.method);

const admit = (auth: RequiredAuth, req: FastifyRequest, reply: FastifyReply, principal: Principal) => {
  const required = requiredScope(req);
  if (!hasScope(principal.scopes, required)) {
    return rejectWithChallenge(req, reply, auth.publicUrl, authErrors.insufficientScope(required));
  }
  req.principal = principal;
  return undefined;
};

const authenticateBearer = async (
  auth: RequiredAuth,
  req: FastifyRequest,
  reply: FastifyReply,
  token: string | null,
) => {
  if (token === null) return rejectWithChallenge(req, reply, auth.publicUrl, authErrors.invalidToken);
  const resolved: Resolution = await resolveBearerPrincipal(auth, token);
  if ('failure' in resolved) return reject(reply, resolved.failure);
  if (resolved.principal === null) return rejectWithChallenge(req, reply, auth.publicUrl, authErrors.invalidToken);
  return admit(auth, req, reply, resolved.principal);
};

// Decide from the route the router actually matched (it decodes `/%61pi/…` to `/api/…`); the raw path only
// for a request no route matched, where the answer is a 404 or a 401 anyway.
const bearerCredentialOf = (req: FastifyRequest) =>
  acceptsBearer(req.routeOptions.url ?? pathOf(req.url)) ? credentialOf(req.headers.authorization) : null;

const authenticateSession = async (auth: RequiredAuth, req: FastifyRequest, reply: FastifyReply) => {
  const resolved = await resolvePrincipal(auth, req);
  if ('failure' in resolved) return reject(reply, resolved.failure);
  if (resolved.principal === null) return rejectUnauthenticated(auth, req, reply);

  // Cookie-authenticated, so unsafe methods (including POST /mcp) must come from our own origin.
  const verdict = csrfVerdict(csrfInput(req, auth.publicUrl));
  return verdict ? reject(reply, verdict) : admit(auth, req, reply, resolved.principal);
};

const guardRequest = (auth: RequiredAuth) => async (req: FastifyRequest, reply: FastifyReply) => {
  if (isPublicRoute(req.routeOptions.url, req.method)) {
    const verdict = preSessionCsrfVerdict(csrfInput(req, auth.publicUrl));
    return verdict ? reject(reply, verdict) : undefined;
  }
  const credential = bearerCredentialOf(req);
  if (credential !== null && credential.kind !== 'none') {
    return authenticateBearer(auth, req, reply, credential.kind === 'bearer' ? credential.token : null);
  }
  return authenticateSession(auth, req, reply);
};

export const registerAuthHook = (app: FastifyInstance, auth: HttpAuth): void => {
  app.decorateRequest('principal', undefined);
  app.addHook('onRequest', auth.mode === AuthMode.enum.disabled ? admitOwnerOnLoopback : guardRequest(auth));
};
