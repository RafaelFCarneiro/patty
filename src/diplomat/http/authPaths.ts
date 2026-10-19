import { API_PATH_PREFIX, MCP_PATH, MCP_PRM_PATH, PRM_WELL_KNOWN_PATH } from '../../models/auth/bearer.js';
import { CONNECT_PATH, INVITE_PATH, UI_ROOT_PATH } from '../../models/auth/origin.js';
import { UserAction } from '../../models/auth/users.js';

/** Route paths of the HTTP surface that authentication itself needs to name — one home, so the auth
 *  hook, the auth routes, the UI routes and the health route can never disagree on a literal. */
export const HEALTH_PATH = '/api/health';
export { API_PATH_PREFIX, CONNECT_PATH, INVITE_PATH, MCP_PATH, MCP_PRM_PATH, PRM_WELL_KNOWN_PATH, UI_ROOT_PATH };
// Two segments on purpose: `/ui/:name` is the one-segment dashboard namespace, and a dashboard may be named anything
// (including `tokens`), so token management must live outside it.
export const TOKENS_PATH = `${UI_ROOT_PATH}/access/tokens`;
export const TOKEN_REVOKE_PATH = `${TOKENS_PATH}/:id/revoke`;
// User management: admin-only pages, two segments under /ui/access for the same reason as the token pages.
export const USERS_PATH = `${UI_ROOT_PATH}/access/users`;
export const USERS_CAP_PATH = `${USERS_PATH}/sign-in-cap`;
const userActionPath = (action: UserAction): string => `${USERS_PATH}/:id/${action}`;
export const USER_REISSUE_PATH = userActionPath(UserAction.enum.reissue);
export const USER_DISABLE_PATH = userActionPath(UserAction.enum.disable);
export const USER_ENABLE_PATH = userActionPath(UserAction.enum.enable);
export const USER_ROLE_PATH = userActionPath(UserAction.enum.role);
/** The URL one user's action form posts to. */
export const userActionUrl = (userId: string, action: UserAction): string =>
  userActionPath(action).replace(':id', encodeURIComponent(userId));
export const LOGIN_PATH = `${UI_ROOT_PATH}/login`;
export const SETUP_PATH = `${UI_ROOT_PATH}/setup`;
export const LOGOUT_PATH = `${UI_ROOT_PATH}/logout`;
export const UI_APP_CSS_PATH = `${UI_ROOT_PATH}/assets/app.css`;

/** After a form POST (login, setup, logout) the browser is sent on with a GET. */
export const SEE_OTHER = 303;

const GET_METHODS = ['GET', 'HEAD'] as const;
const FORM_METHODS = ['GET', 'HEAD', 'POST'] as const;

/**
 * The ENTIRE unauthenticated surface: liveness, the three pages that create a session, and
 * the one static asset those pages use. Matched against the route's registered pattern + method, never
 * the raw URL, so path tricks cannot reach it; anything absent here — including a path no route
 * matches — needs a credential. The Protected Resource Metadata (RFC 9728) is public by definition: a client
 * reads it from the 401 challenge, before it holds any token. `/oauth/*` joins in Phase 3.
 */
export const PUBLIC_ROUTES: Readonly<Record<string, readonly string[]>> = {
  [HEALTH_PATH]: GET_METHODS,
  [LOGIN_PATH]: FORM_METHODS,
  [SETUP_PATH]: FORM_METHODS,
  [INVITE_PATH]: FORM_METHODS,
  [UI_APP_CSS_PATH]: GET_METHODS,
  [PRM_WELL_KNOWN_PATH]: GET_METHODS,
  [MCP_PRM_PATH]: GET_METHODS,
};

export const isPublicRoute = (routePattern: string | undefined, method: string): boolean =>
  routePattern !== undefined && (PUBLIC_ROUTES[routePattern]?.includes(method.toUpperCase()) ?? false);
