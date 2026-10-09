import { API_PATH_PREFIX, MCP_PATH, MCP_PRM_PATH, PRM_WELL_KNOWN_PATH, UI_ROOT_PATH } from '../../models/auth.js';

/** Route paths of the HTTP surface that authentication itself needs to name — one home, so the auth
 *  hook, the auth routes, the UI routes and the health route can never disagree on a literal. */
export const HEALTH_PATH = '/api/health';
export { API_PATH_PREFIX, MCP_PATH, MCP_PRM_PATH, PRM_WELL_KNOWN_PATH, UI_ROOT_PATH };
// Two segments on purpose: `/ui/:name` is the one-segment dashboard namespace, and a dashboard may be named anything
// (including `tokens`), so token management must live outside it.
export const TOKENS_PATH = `${UI_ROOT_PATH}/account/tokens`;
export const TOKEN_REVOKE_PATH = `${TOKENS_PATH}/:id/revoke`;
export const LOGIN_PATH = `${UI_ROOT_PATH}/login`;
export const SETUP_PATH = `${UI_ROOT_PATH}/setup`;
export const LOGOUT_PATH = `${UI_ROOT_PATH}/logout`;
export const UI_APP_CSS_PATH = `${UI_ROOT_PATH}/assets/app.css`;

/** After a form POST (login, setup, logout) the browser is sent on with a GET. */
export const SEE_OTHER = 303;

const GET_METHODS = ['GET', 'HEAD'] as const;
const FORM_METHODS = ['GET', 'HEAD', 'POST'] as const;

/**
 * The ENTIRE unauthenticated surface (ADR-033 §6): liveness, the two pages that create a session, and
 * the one static asset those pages use. Matched against the route's registered pattern + method, never
 * the raw URL, so path tricks cannot reach it; anything absent here — including a path no route
 * matches — needs a credential. The Protected Resource Metadata (RFC 9728) is public by definition: a client
 * reads it from the 401 challenge, before it holds any token. `/oauth/*` joins in Phase 3.
 */
export const PUBLIC_ROUTES: Readonly<Record<string, readonly string[]>> = {
  [HEALTH_PATH]: GET_METHODS,
  [LOGIN_PATH]: FORM_METHODS,
  [SETUP_PATH]: FORM_METHODS,
  [UI_APP_CSS_PATH]: GET_METHODS,
  [PRM_WELL_KNOWN_PATH]: GET_METHODS,
  [MCP_PRM_PATH]: GET_METHODS,
};

export const isPublicRoute = (routePattern: string | undefined, method: string): boolean =>
  routePattern !== undefined && (PUBLIC_ROUTES[routePattern]?.includes(method.toUpperCase()) ?? false);
