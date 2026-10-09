import { hasScope } from '../../logic/auth.js';
import { TOKEN_NAME_MAX_LENGTH, TokenStatus, WRITE_SCOPE, type AccessTokenSummary } from '../../models/auth.js';
import { errorBlock, escapeHtml, fillTemplate } from './authPages.js';
import { TOKENS_PATH, UI_APP_CSS_PATH, UI_ROOT_PATH } from './authPaths.js';
import { readCached, UI_ROOT } from './uiFiles.js';

const TOKENS_TEMPLATE_PATH = `${UI_ROOT}/tokens.html`;
const TOKEN_CREATED_TEMPLATE_PATH = `${UI_ROOT}/tokenCreated.html`;

const NEVER = 'never';
const NOT_YET = '—';
const ISO_MINUTE_LENGTH = 16;

const SCOPE_LABEL = { read: 'read only', write: 'read + write' } as const;

/** `2026-10-09T12:34:56.000Z` → `2026-10-09 12:34 UTC`; absolute, so the page needs no script or locale. */
const when = (iso: string | null, fallback: string): string =>
  iso === null ? fallback : `${iso.slice(0, ISO_MINUTE_LENGTH).replace('T', ' ')} UTC`;

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
  `<td>${when(token.expiresAt, NEVER)}</td>` +
  `<td class="token-status-${token.status}">${token.status}</td>` +
  `<td>${revokeForm(token)}</td>` +
  '</tr>';

const table = (tokens: readonly AccessTokenSummary[]): string =>
  tokens.length === 0
    ? '<p class="auth-hint">No access tokens yet.</p>'
    : '<div class="tokens-scroll"><table class="tokens-table"><thead><tr>' +
      '<th>Name</th><th>Token</th><th>Access</th><th>Created</th><th>Last used</th><th>Expires</th><th>Status</th><th></th>' +
      `</tr></thead><tbody>${tokens.map(row).join('')}</tbody></table></div>`;

export const renderTokensPage = async (fields: {
  tokens: readonly AccessTokenSummary[];
  error?: string;
}): Promise<string> =>
  fillTemplate(await readCached(TOKENS_TEMPLATE_PATH), {
    stylesheet: UI_APP_CSS_PATH,
    action: TOKENS_PATH,
    dashboards: UI_ROOT_PATH,
    nameMaxLength: String(TOKEN_NAME_MAX_LENGTH),
    tokens: table(fields.tokens),
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
