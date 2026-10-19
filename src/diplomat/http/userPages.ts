import * as R from 'remeda';
import { PASSWORD_MIN_LENGTH } from '../../models/auth/password.js';
import { UserRole } from '../../models/auth/owner.js';
import {
  INVITE_TTL_HOURS,
  SignInCap,
  UserAction,
  UserStatus,
  type IssuedInvite,
  type UserSummary,
} from '../../models/auth/users.js';
import { errorBlock, escapeHtml, fillTemplate, formatMinute } from './authPages.js';
import {
  INVITE_PATH,
  TOKENS_PATH,
  UI_APP_CSS_PATH,
  UI_ROOT_PATH,
  userActionUrl,
  USERS_CAP_PATH,
  USERS_PATH,
} from './authPaths.js';
import { readCached, UI_ROOT } from './uiFiles.js';

const USERS_TEMPLATE_PATH = `${UI_ROOT}/users.html`;
const INVITED_TEMPLATE_PATH = `${UI_ROOT}/userInvited.html`;
const INVITE_TEMPLATE_PATH = `${UI_ROOT}/invite.html`;

const NEVER = '—';
const UNNAMED = '(not set up yet)';

const ROLE_LABEL: Readonly<Record<UserRole, string>> = {
  admin: 'Administrator — manages users',
  member: 'Member — their own finances only',
};

const CAP_LABEL: Readonly<Record<SignInCap, string>> = { '24h': '24 hours', '7d': '7 days', '30d': '30 days' };

const option = (value: string, label: string, selected = false): string =>
  `<option value="${escapeHtml(value)}"${selected ? ' selected' : ''}>${escapeHtml(label)}</option>`;

const roleOptions = (selected: UserRole): string =>
  UserRole.options.map((role) => option(role, ROLE_LABEL[role], role === selected)).join('');

const capOptions = (selected: SignInCap): string =>
  SignInCap.options.map((cap) => option(cap, CAP_LABEL[cap], cap === selected)).join('');

const when = (iso: string | null, fallback = NEVER): string => (iso === null ? fallback : formatMinute(iso));

const passwordField = (label: string): string =>
  `<input name="password" type="password" autocomplete="current-password" placeholder="Your password" ` +
  `aria-label="${escapeHtml(label)}" required />`;

const actionForm = (user: UserSummary, action: UserAction, button: string, fields = ''): string =>
  `<form method="post" action="${userActionUrl(user.id, action)}">${fields}` +
  `<button type="submit" class="token-revoke">${escapeHtml(button)}</button></form>`;

const nameOf = (user: UserSummary): string => user.username ?? UNNAMED;

const stepUpForm = (user: UserSummary, action: UserAction, button: string): string =>
  actionForm(user, action, button, passwordField(`Your password to ${button.toLowerCase()} ${nameOf(user)}`));

const roleForm = (user: UserSummary): string =>
  actionForm(
    user,
    UserAction.enum.role,
    'Set role',
    `<select name="role" aria-label="Role of ${escapeHtml(nameOf(user))}">${roleOptions(user.role)}</select>` +
      passwordField(`Your password to change the role of ${nameOf(user)}`),
  );

// Typed by the status, so a new status cannot exist without its actions.
const ACTIONS: Readonly<Record<UserStatus, (user: UserSummary) => string>> = {
  invited: (user) =>
    stepUpForm(user, UserAction.enum.reissue, 'Reissue invite') + stepUpForm(user, UserAction.enum.disable, 'Disable'),
  active: (user) =>
    roleForm(user) +
    stepUpForm(user, UserAction.enum.reissue, 'Reset password') +
    stepUpForm(user, UserAction.enum.disable, 'Disable'),
  disabled: (user) => stepUpForm(user, UserAction.enum.enable, 'Enable'),
};

const statusCell = (user: UserSummary): string =>
  user.status === UserStatus.enum.invited && user.inviteExpiresAt !== null
    ? `invited (expires ${formatMinute(user.inviteExpiresAt)})`
    : user.status;

const row = (user: UserSummary): string =>
  `<tr data-user="${escapeHtml(nameOf(user))}">` +
  `<td>${escapeHtml(nameOf(user))}</td>` +
  `<td>${user.role}</td>` +
  `<td class="user-status-${user.status}">${statusCell(user)}</td>` +
  `<td>${when(user.createdAt)}</td>` +
  `<td>${when(user.lastLoginAt)}</td>` +
  `<td class="user-actions">${ACTIONS[user.status](user)}</td>` +
  '</tr>';

const table = (users: readonly UserSummary[]): string =>
  '<div class="tokens-scroll"><table class="tokens-table"><thead><tr>' +
  '<th>Username</th><th>Role</th><th>Status</th><th>Created</th><th>Last login</th><th></th>' +
  `</tr></thead><tbody>${R.map(users, row).join('')}</tbody></table></div>`;

export const renderUsersPage = async (fields: {
  users: readonly UserSummary[];
  cap: SignInCap;
  error?: string;
}): Promise<string> =>
  fillTemplate(await readCached(USERS_TEMPLATE_PATH), {
    stylesheet: UI_APP_CSS_PATH,
    tokensPath: TOKENS_PATH,
    dashboards: UI_ROOT_PATH,
    inviteAction: USERS_PATH,
    capAction: USERS_CAP_PATH,
    inviteHours: String(INVITE_TTL_HOURS),
    roleOptions: roleOptions(UserRole.enum.member),
    capOptions: capOptions(fields.cap),
    users: table(fields.users),
    error: errorBlock(fields.error),
  });

const linkBlock = (link: string | null): string =>
  link === null ? '' : `<p>Link</p><p class="token-secret" data-testid="invite-link">${escapeHtml(link)}</p>`;

const consequenceOf = (issued: IssuedInvite): string => {
  const { sessionsEnded, tokensRevoked } = issued.revoked;
  return sessionsEnded + tokensRevoked === 0
    ? 'They choose their own password; you never see it.'
    : `Their password is gone and ${sessionsEnded} session(s) and ${tokensRevoked} token(s) or sign-in(s) ended; ` +
        'this invite is the only way back in.';
};

/** The one place an invite's code and link are ever rendered. `link` is null when the instance cannot name its own
 *  origin (set `PUBLIC_URL`); the code can still be typed at the invite page. */
export const renderInvitedPage = async (fields: {
  heading: string;
  issued: IssuedInvite;
  link: string | null;
}): Promise<string> =>
  fillTemplate(await readCached(INVITED_TEMPLATE_PATH), {
    stylesheet: UI_APP_CSS_PATH,
    heading: escapeHtml(fields.heading),
    username: escapeHtml(fields.issued.user.username ?? UNNAMED),
    role: fields.issued.user.role,
    consequence: escapeHtml(consequenceOf(fields.issued)),
    expiresAt: formatMinute(fields.issued.expiresAt),
    link: linkBlock(fields.link),
    code: escapeHtml(fields.issued.code),
    invitePath: INVITE_PATH,
    usersPath: USERS_PATH,
  });

/** The claim page. `code` is whatever the link carried (escaped); never the password. */
export const renderInvitePage = async (fields: { code: string; error?: string }): Promise<string> =>
  fillTemplate(await readCached(INVITE_TEMPLATE_PATH), {
    stylesheet: UI_APP_CSS_PATH,
    action: INVITE_PATH,
    code: escapeHtml(fields.code),
    passwordMinLength: String(PASSWORD_MIN_LENGTH),
    error: errorBlock(fields.error),
  });
