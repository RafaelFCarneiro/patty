import { PASSWORD_MIN_LENGTH, TERMINAL_SETUP_HINT } from '../../models/auth.js';
import { LOGIN_PATH, SETUP_PATH, UI_APP_CSS_PATH } from './authPaths.js';
import { readCached, UI_ROOT } from './uiFiles.js';

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
