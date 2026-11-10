import { NPX_COMMAND, PRODUCT_NAME } from '../package.js';
import { TOKEN_ENV_VAR } from './sign-in.js';

/** The terminal route to the same owner claim as `/ui/setup` — shown wherever the setup code is. */
export const TERMINAL_SETUP_COMMAND = `${NPX_COMMAND} auth setup`;
export const TERMINAL_SETUP_HINT = `or run \`${TERMINAL_SETUP_COMMAND}\` in a terminal`;

export const AUTH_MESSAGES = {
  invalidCredentials: 'Invalid username or password.',
  invalidSetupCode: `That setup code is not valid or has expired. Restart ${PRODUCT_NAME} to get a new one.`,
  setupUnavailable: 'Setup has already been completed. Log in instead.',
  unknownUser: 'No such user.',
  ownerUnclaimed: `The owner has no login yet. Run \`${TERMINAL_SETUP_COMMAND}\` first.`,
  rateLimited: 'Too many attempts. Wait a few minutes and try again.',
  unauthenticated: 'Authentication required.',
  crossOrigin: 'Cross-origin request rejected.',
  crossOriginUnknownOrigin:
    "Cross-origin check could not determine this instance's own origin — set PUBLIC_URL to its external URL.",
  tryAgain: 'Could not complete the request. Try again.',
  invalidToken: 'The access token is invalid, expired or revoked.',
  invalidPassword: 'That password is not correct.',
  insufficientScope: 'The access token does not grant the scope this operation needs.',
  unknownToken: 'No such access token.',
  sessionRequired: 'Access tokens can only be managed from a signed-in browser session.',
  invalidGrant: 'This sign-in request is not valid, has expired, or was already answered.',
  adminRequired: 'Only an administrator can manage users.',
  usernameTaken: 'That username is already taken.',
  cannotChangeSelf: 'You cannot disable or demote yourself. Ask another administrator.',
  lastAdmin: 'That would leave the instance without an active administrator.',
  invalidInvite: 'That invite is not valid, has expired, or was already used. Ask an administrator for a new one.',
  userDisabled: 'That user is disabled. Enable them first.',
  prmNeedsOrigin:
    'This instance cannot say what its own origin is — set PUBLIC_URL to its external URL to publish its ' +
    'Protected Resource Metadata.',
  nonLoopbackRequest:
    `Request host/origin is not loopback — ${PRODUCT_NAME} without authentication only answers 127.0.0.1, localhost or ` +
    '::1. To use another hostname, set PUBLIC_URL (which turns authentication on).',
} as const;

/** The headings of the user-management result pages. */
export const USER_PAGE_HEADINGS = { inviteCreated: 'Invite created', newInvite: 'New invite' } as const;

export const HTTP_ENV_VAR = 'PATTY_HTTP';

/** What a stdio session says when it cannot act as anyone (ADR-034 §2). One template per situation, built here so
 *  the wording — and the pinned command in it — exists once. None of them may carry a secret: the link holds the
 *  user code only, and a rejected `PATTY_TOKEN` is never echoed. */
const SIGN_IN_PREFIX = `${PRODUCT_NAME}:`;

export const STDIO_MESSAGES = {
  notSignedIn: (connectUrl: string, userCode: string) =>
    `${SIGN_IN_PREFIX} not signed in. Open ${connectUrl} and confirm the code ${userCode}.`,
  notSignedInWithoutHttp:
    `${SIGN_IN_PREFIX} not signed in. The browser sign-in needs the HTTP dashboard (${HTTP_ENV_VAR}=false here): run ` +
    `\`${NPX_COMMAND} login\` in a terminal, or set ${TOKEN_ENV_VAR} in this client's environment.`,
  ownerUnclaimedHint: ` Owner not set up yet? Run \`${NPX_COMMAND} auth setup\`.`,
  invalidEnvToken:
    `${SIGN_IN_PREFIX} ${TOKEN_ENV_VAR} is not a valid access token (malformed, expired or revoked). Create a new one on ` +
    `the Access page of the dashboard, or remove ${TOKEN_ENV_VAR} from this client's environment to sign in with ` +
    `the browser instead.`,
  cannotVerify: `${SIGN_IN_PREFIX} could not check the sign-in just now. Try again.`,
} as const;
