import * as R from 'remeda';
import { hasScope } from '../../logic/auth/scope.js';
import { WRITE_SCOPE } from '../../models/auth/scope.js';
import {
  AccessTokenKind,
  type AccessTokenSummary,
  DEFAULT_TOKEN_EXPIRY,
  TOKEN_EXPIRY_DAYS,
  TOKEN_NAME_MAX_LENGTH,
  TokenAccess,
  TokenExpiry,
  TokenStatus,
} from '../../models/auth/token.js';
import { ACCESS_LABEL, errorBlock, escapeHtml, fillTemplate, formatMinute } from './authPages.js';
import { TOKENS_PATH, UI_APP_CSS_PATH, UI_ROOT_PATH, USERS_PATH } from './authPaths.js';
import { readCached, UI_ROOT } from './uiFiles.js';

const TOKENS_TEMPLATE_PATH = `${UI_ROOT}/tokens.html`;
const TOKEN_CREATED_TEMPLATE_PATH = `${UI_ROOT}/tokenCreated.html`;

const NOT_YET = '—';

// Only a token minted before ADR-034 §6 can have no expiry; it still works until revoked, and the list says so.
const LEGACY_NO_EXPIRY_LABEL = 'No expiry (legacy)';

const expiryLabel = (expiry: TokenExpiry): string => `in ${TOKEN_EXPIRY_DAYS[expiry]} days`;

const option = (value: string, label: string, selected = false): string =>
  `<option value="${escapeHtml(value)}"${selected ? ' selected' : ''}>${escapeHtml(label)}</option>`;

const accessOptions = (): string => TokenAccess.options.map((access) => option(access, ACCESS_LABEL[access])).join('');

const expiryOptions = (): string =>
  R.pipe(
    TokenExpiry.options,
    R.sortBy((expiry) => TOKEN_EXPIRY_DAYS[expiry]),
    R.map((expiry) => option(expiry, expiryLabel(expiry), expiry === DEFAULT_TOKEN_EXPIRY)),
  ).join('');

const SCOPE_LABEL = { read: 'read only', write: 'read + write' } as const;

const when = (iso: string | null, fallback: string): string => (iso === null ? fallback : formatMinute(iso));

const accessOf = (token: AccessTokenSummary): string =>
  hasScope(token.scopes, WRITE_SCOPE) ? SCOPE_LABEL.write : SCOPE_LABEL.read;

const revokeForm = (token: AccessTokenSummary): string =>
  token.status === TokenStatus.enum.active
    ? `<form method="post" action="${TOKENS_PATH}/${escapeHtml(token.id)}/revoke">` +
      `<button type="submit" class="token-revoke" aria-label="Revoke ${escapeHtml(token.name)}">Revoke</button></form>`
    : '';

const row = (token: AccessTokenSummary): string =>
  '<tr>' +
  `<td>${escapeHtml(token.name)}</td>` +
  `<td><code>${escapeHtml(token.prefix)}…</code></td>` +
  `<td>${accessOf(token)}</td>` +
  `<td>${when(token.createdAt, NOT_YET)}</td>` +
  `<td>${when(token.lastUsedAt, NOT_YET)}</td>` +
  `<td>${when(token.expiresAt, LEGACY_NO_EXPIRY_LABEL)}</td>` +
  `<td class="token-status-${token.status}">${token.status}</td>` +
  `<td>${revokeForm(token)}</td>` +
  '</tr>';

const signInRow = (signIn: AccessTokenSummary): string =>
  '<tr>' +
  // The client name is whatever the spawning program reported about itself.
  `<td>${escapeHtml(signIn.clientName ?? signIn.name)}</td>` +
  `<td>${escapeHtml(signIn.profile ?? '')}</td>` +
  `<td>${accessOf(signIn)}</td>` +
  `<td>${when(signIn.createdAt, NOT_YET)}</td>` +
  `<td>${when(signIn.expiresAt, LEGACY_NO_EXPIRY_LABEL)}</td>` +
  `<td>${when(signIn.lastUsedAt, NOT_YET)}</td>` +
  `<td class="token-status-${signIn.status}">${signIn.status}</td>` +
  `<td>${revokeForm(signIn)}</td>` +
  '</tr>';

const signInsTable = (signIns: readonly AccessTokenSummary[]): string =>
  signIns.length === 0
    ? '<p class="auth-hint">No Claude sign-ins yet.</p>'
    : '<div class="tokens-scroll"><table class="tokens-table"><thead><tr>' +
      '<th>Client</th><th>Profile</th><th>Access</th><th>Signed in</th><th>Expires</th><th>Last used</th><th>Status</th><th></th>' +
      `</tr></thead><tbody>${signIns.map(signInRow).join('')}</tbody></table></div>`;

const table = (tokens: readonly AccessTokenSummary[]): string =>
  tokens.length === 0
    ? '<p class="auth-hint">No access tokens yet.</p>'
    : '<div class="tokens-scroll"><table class="tokens-table"><thead><tr>' +
      '<th>Name</th><th>Token</th><th>Access</th><th>Created</th><th>Last used</th><th>Expires</th><th>Status</th><th></th>' +
      `</tr></thead><tbody>${tokens.map(row).join('')}</tbody></table></div>`;

const usersLink = (show: boolean): string => (show ? `<a href="${USERS_PATH}">Users</a> · ` : '');

export const renderTokensPage = async (fields: {
  tokens: readonly AccessTokenSummary[];
  showUsersLink: boolean;
  error?: string;
}): Promise<string> =>
  fillTemplate(await readCached(TOKENS_TEMPLATE_PATH), {
    stylesheet: UI_APP_CSS_PATH,
    action: TOKENS_PATH,
    dashboards: UI_ROOT_PATH,
    usersLink: usersLink(fields.showUsersLink),
    nameMaxLength: String(TOKEN_NAME_MAX_LENGTH),
    accessOptions: accessOptions(),
    expiryOptions: expiryOptions(),
    tokens: table(R.filter(fields.tokens, (token) => token.kind === AccessTokenKind.enum.pat)),
    signIns: signInsTable(R.filter(fields.tokens, (token) => token.kind === AccessTokenKind.enum.stdio)),
    error: errorBlock(fields.error),
  });

/** The one place the plaintext token is ever rendered. */
export const renderTokenCreatedPage = async (fields: { token: string; summary: AccessTokenSummary }): Promise<string> =>
  fillTemplate(await readCached(TOKEN_CREATED_TEMPLATE_PATH), {
    stylesheet: UI_APP_CSS_PATH,
    name: escapeHtml(fields.summary.name),
    access: accessOf(fields.summary),
    token: escapeHtml(fields.token),
    tokensPath: TOKENS_PATH,
  });
