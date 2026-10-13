import { HTTP_SCHEME_PREFIX, hostnameOfHostHeader, isLoopbackHost } from '../../common/net.js';
import { authErrors, type AuthError } from '../../models/auth/errors.js';
import {
  CONNECT_CODE_PARAM,
  CONNECT_PATH,
  OPAQUE_ORIGIN,
  SAFE_METHODS,
  WEB_PROTOCOLS,
  type CsrfRequest,
} from '../../models/auth/origin.js';

export const isUnsafeMethod = (method: string): boolean => !SAFE_METHODS.has(method.toUpperCase());

const parsedUrl = (url: string): URL | null => {
  try {
    return new URL(url);
  } catch {
    return null;
  }
};

const originOf = (url: string): string | null => {
  const parsed = parsedUrl(url);
  // Opaque origins (`null`, data:, file:) never equal a real expected origin.
  return parsed === null || parsed.origin === OPAQUE_ORIGIN ? null : parsed.origin;
};

/** The browser-declared origin of a request: `Origin`, else the `Referer`'s origin, else unknown. */
export const declaredOrigin = (origin: string | undefined, referer: string | undefined): string | null =>
  origin !== undefined ? originOf(origin) : referer !== undefined ? originOf(referer) : null;

export const isSameOrigin = (expectedOrigin: string, declared: string | null): boolean =>
  declared !== null && declared === expectedOrigin;

/** Origins a browser may legitimately send for this request: `PUBLIC_URL`, plus — when the request itself
 *  arrived at a loopback host — that host's own origin (a local operator reaching a container through its
 *  loopback port publish). Never derived from a non-loopback `Host`, which a rebinding attacker controls. */
export const allowedOrigins = (publicUrl: string | undefined, hostHeader: string | undefined): string[] => {
  const hostname = hostHeader === undefined ? null : hostnameOfHostHeader(hostHeader);
  const ownLoopbackOrigin =
    hostHeader !== undefined && hostname !== null && isLoopbackHost(hostname)
      ? [`${HTTP_SCHEME_PREFIX}${hostHeader}`]
      : [];
  return [...(publicUrl === undefined ? [] : [publicUrl]), ...ownLoopbackOrigin];
};

/**
 * The CSRF verdict for a request that carries ambient credentials (the session cookie): a safe method passes;
 * an unsafe one (`POST`/`PUT`/`PATCH`/`DELETE`, including `POST /mcp`) must declare — in `Origin`, else
 * `Referer` — an origin from `allowedOrigins`. `null` = allowed; otherwise the error to send (`unknownOrigin`
 * when this instance cannot say what its own origin is, `crossOrigin` when the declared one is not ours).
 */
export const csrfVerdict = (request: CsrfRequest): AuthError | null => {
  if (!isUnsafeMethod(request.method)) return null;
  const allowed = allowedOrigins(request.publicUrl, request.host);
  if (allowed.length === 0) return authErrors.unknownOrigin;
  const declared = declaredOrigin(request.origin, request.referer);
  return allowed.some((origin) => isSameOrigin(origin, declared)) ? null : authErrors.crossOrigin;
};

/**
 * The same check for the pre-session `POST`s (login, setup), which carry no cookie to forge but are still a
 * forced-login vector from a cross-site page: a browser that declares an origin must declare ours; a client
 * that declares none (`curl`, scripts) has no browser to defend.
 */
export const preSessionCsrfVerdict = (request: CsrfRequest): AuthError | null =>
  request.origin === undefined && request.referer === undefined ? null : csrfVerdict(request);

// An `Origin` of http(s) on a loopback host, any port (MCP Inspector at http://localhost:6274 must keep working).
// An opaque (`null`), malformed or non-web origin is not loopback.
const isLoopbackOrigin = (origin: string): boolean => {
  const parsed = parsedUrl(origin);
  return (
    parsed !== null &&
    parsed.origin !== OPAQUE_ORIGIN &&
    WEB_PROTOCOLS.has(parsed.protocol) &&
    isLoopbackHost(parsed.hostname)
  );
};

/**
 * With auth disabled every request acts as the owner, so the only thing standing between a web page and the
 * user's finances is who the request says it is for. DNS rebinding sends `Host: attacker.example` to 127.0.0.1;
 * a cross-site `fetch`/form POST sends `Origin: https://evil.example`. Config guarantees disabled ⇒ loopback bind,
 * so every legitimate request names a loopback `Host`; a missing or malformed `Host` is refused, and an `Origin`
 * — which native MCP clients, curl and stdio-adjacent tools simply don't send — must be loopback if present.
 */
export const isLoopbackRequest = (request: { host: string | undefined; origin: string | undefined }): boolean => {
  const hostname = request.host === undefined ? null : hostnameOfHostHeader(request.host);
  if (hostname === null || !isLoopbackHost(hostname)) return false;
  return request.origin === undefined || isLoopbackOrigin(request.origin);
};

/**
 * The origin a stdio session's sign-in link may name from what it already knows, or `null`: `PUBLIC_URL`, else the
 * sidecar THIS process bound. Never a configured `HOST:PORT` it did not bind — whatever listens there may have opened a
 * different database, so a grant written here would never validate there — and, without `PUBLIC_URL`, never a
 * non-loopback host either: the page's cookie-authenticated POSTs trust only `PUBLIC_URL` or a loopback `Host` (CSRF).
 * `null` with HTTP enabled means "serve it yourself" (the session starts a temporary server of its own); with HTTP off
 * there is no page at all and the message says to use `login` or `FINTRACK_TOKEN`.
 */
export const signInOrigin = (fields: {
  httpEnabled: boolean;
  publicUrl: string | undefined;
  boundOrigin: string | null;
  host: string;
}): string | null => {
  if (!fields.httpEnabled) return null;
  if (fields.publicUrl !== undefined) return fields.publicUrl;
  return isLoopbackHost(fields.host) ? fields.boundOrigin : null;
};

export const connectUrl = (origin: string, userCode: string): string =>
  `${origin}${CONNECT_PATH}?${CONNECT_CODE_PARAM}=${userCode}`;

/** The origin the resource is served from: `PUBLIC_URL`, else the request's own loopback origin; `null` when
 *  the instance cannot say (non-loopback host, no `PUBLIC_URL`). */
export const resourceOrigin = (publicUrl: string | undefined, host: string | undefined): string | null =>
  allowedOrigins(publicUrl, host)[0] ?? null;
