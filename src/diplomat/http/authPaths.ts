import { UI_ROOT_PATH } from '../../models/auth.js';

/** Route paths of the HTTP surface that authentication itself needs to name — one home, so the auth
 *  hook, the auth routes, the UI routes and the health route can never disagree on a literal. */
export const HEALTH_PATH = '/api/health';
export { UI_ROOT_PATH };
export const LOGIN_PATH = `${UI_ROOT_PATH}/login`;
export const SETUP_PATH = `${UI_ROOT_PATH}/setup`;
export const LOGOUT_PATH = `${UI_ROOT_PATH}/logout`;
export const UI_APP_CSS_PATH = `${UI_ROOT_PATH}/assets/app.css`;

/** After a form POST (login, setup, logout) the browser is sent on with a GET. */
export const SEE_OTHER = 303;
export const API_PATH_PREFIX = '/api';

const GET_METHODS = ['GET', 'HEAD'] as const;
const FORM_METHODS = ['GET', 'HEAD', 'POST'] as const;

/**
 * The ENTIRE unauthenticated surface (ADR-033 §6): liveness, the two pages that create a session, and
 * the one static asset those pages use. Matched against the route's registered pattern + method, never
 * the raw URL, so path tricks cannot reach it; anything absent here — including a path no route
 * matches — needs a session. `/.well-known/*` and `/oauth/*` join it in Phases 2–3.
 */
export const PUBLIC_ROUTES: Readonly<Record<string, readonly string[]>> = {
  [HEALTH_PATH]: GET_METHODS,
  [LOGIN_PATH]: FORM_METHODS,
  [SETUP_PATH]: FORM_METHODS,
  [UI_APP_CSS_PATH]: GET_METHODS,
};

export const isPublicRoute = (routePattern: string | undefined, method: string): boolean =>
  routePattern !== undefined && (PUBLIC_ROUTES[routePattern]?.includes(method.toUpperCase()) ?? false);
