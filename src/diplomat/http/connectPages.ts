import * as R from 'remeda';
import { SignInDuration, TokenAccess, type GrantChoice, type GrantRequest } from '../../models/auth.js';
import { durationAllowedFor } from '../../logic/auth.js';
import { errorBlock, escapeHtml, fillTemplate } from './authPages.js';
import { CONNECT_PATH, UI_APP_CSS_PATH, UI_ROOT_PATH } from './authPaths.js';
import { readCached, UI_ROOT } from './uiFiles.js';

const CONNECT_TEMPLATE_PATH = `${UI_ROOT}/connect.html`;
const CONNECT_RESULT_TEMPLATE_PATH = `${UI_ROOT}/connectResult.html`;

const ISO_MINUTE_LENGTH = 16;

// Typed by the enums, so a new access level or duration cannot exist without a label here — and the radio values the
// form posts are the very values `ConnectFormSchema` accepts.
const ACCESS_LABEL: Readonly<Record<TokenAccess, string>> = {
  read: 'Read only — list and query, never change anything',
  write: 'Read and write — can also record, edit and delete',
};

const DURATION_LABEL: Readonly<Record<SignInDuration, string>> = {
  session: 'This Claude session only',
  '24h': '24 hours',
  '7d': '7 days',
  '30d': '30 days',
};

/** `2026-10-09T12:34:56.000Z` → `2026-10-09 12:34 UTC`; absolute, so the page needs no script or locale. */
const when = (iso: string): string => `${iso.slice(0, ISO_MINUTE_LENGTH).replace('T', ' ')} UTC`;

const radio = (name: string, value: string, label: string, checked: boolean): string =>
  `<label><input type="radio" name="${name}" value="${escapeHtml(value)}"${checked ? ' checked' : ''} required />` +
  `${escapeHtml(label)}</label>`;

const accessOptions = (selected: TokenAccess): string =>
  TokenAccess.options.map((access) => radio('access', access, ACCESS_LABEL[access], access === selected)).join('');

// "This Claude session only" is for a stdio process, which has a session to tie the sign-in to; `fintrack login`
// does not (the choice would be refused, so it is not offered).
const durationOptions = (request: GrantRequest, selected: SignInDuration): string =>
  R.pipe(
    SignInDuration.options,
    R.filter((duration) => durationAllowedFor(request.channel, duration)),
    R.map((duration) => radio('duration', duration, DURATION_LABEL[duration], duration === selected)),
  ).join('');

export const renderConnectPage = async (fields: {
  request: GrantRequest;
  choice: GrantChoice;
  error?: string;
}): Promise<string> =>
  fillTemplate(await readCached(CONNECT_TEMPLATE_PATH), {
    stylesheet: UI_APP_CSS_PATH,
    action: CONNECT_PATH,
    // Everything the client reported is escaped: it is whatever the spawning program chose to call itself.
    clientName: escapeHtml(fields.request.clientName),
    clientVersion: escapeHtml(fields.request.clientVersion),
    profile: escapeHtml(fields.request.profile),
    requestedAt: when(fields.request.createdAt),
    userCode: escapeHtml(fields.request.userCode),
    accessOptions: accessOptions(fields.choice.access),
    durationOptions: durationOptions(fields.request, fields.choice.duration),
    error: errorBlock(fields.error),
  });

export const renderConnectResultPage = async (fields: { heading: string; message: string }): Promise<string> =>
  fillTemplate(await readCached(CONNECT_RESULT_TEMPLATE_PATH), {
    stylesheet: UI_APP_CSS_PATH,
    heading: escapeHtml(fields.heading),
    message: escapeHtml(fields.message),
    dashboards: UI_ROOT_PATH,
  });
