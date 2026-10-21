import { TERMINAL_SETUP_HINT } from '../../models/auth/message.js';
import { PASSWORD_MIN_LENGTH } from '../../models/auth/password.js';
import type { TokenAccess } from '../../models/auth/token.js';
import { LOGIN_PATH, SETUP_PATH, UI_APP_CSS_PATH } from './auth-paths.js';
import { readCached, UI_ROOT } from './ui-files.js';

const LOGIN_TEMPLATE_PATH = `${UI_ROOT}/login.html`;
const SETUP_TEMPLATE_PATH = `${UI_ROOT}/setup.html`;

const HTML_ESCAPES: Readonly<Record<string, string>> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

export const escapeHtml = (text: string): string => text.replace(/[&<>"']/g, (char) => HTML_ESCAPES[char] ?? char);

const PLACEHOLDER = /\{\{(\w+)\}\}/g;

/** Substitutes `{{name}}` placeholders. Values are inserted verbatim, so callers pass only constants or
 *  `escapeHtml`'d text; an unknown placeholder becomes empty rather than leaking its name. */
export const fillTemplate = (template: string, values: Readonly<Record<string, string>>): string =>
  template.replace(PLACEHOLDER, (_match, name: string) => values[name] ?? '');

const ISO_MINUTE_LENGTH = 16;

/** `2026-10-09T12:34:56.000Z` → `2026-10-09 12:34 UTC`; absolute, so a page needs no script or locale. */
export const formatMinute = (iso: string): string => `${iso.slice(0, ISO_MINUTE_LENGTH).replace('T', ' ')} UTC`;

// Typed by the enum, so a new access level cannot exist without a label — shared by the token form and the consent
// form, whose <option>/radio values are the very values their schemas accept.
export const ACCESS_LABEL: Readonly<Record<TokenAccess, string>> = {
  read: 'Read only — list and query, never change anything',
  write: 'Read and write — can also record, edit and delete',
};

export const errorBlock = (message: string | undefined): string =>
  message === undefined ? '' : `<p class="auth-error" role="alert">${escapeHtml(message)}</p>`;

export const renderLoginPage = async (fields: { next: string; error?: string }): Promise<string> =>
  fillTemplate(await readCached(LOGIN_TEMPLATE_PATH), {
    stylesheet: UI_APP_CSS_PATH,
    action: LOGIN_PATH,
    next: escapeHtml(fields.next),
    error: errorBlock(fields.error),
  });

export const renderSetupPage = async (fields: { error?: string }): Promise<string> =>
  fillTemplate(await readCached(SETUP_TEMPLATE_PATH), {
    stylesheet: UI_APP_CSS_PATH,
    action: SETUP_PATH,
    passwordMinLength: String(PASSWORD_MIN_LENGTH),
    terminalHint: escapeHtml(TERMINAL_SETUP_HINT),
    error: errorBlock(fields.error),
  });
