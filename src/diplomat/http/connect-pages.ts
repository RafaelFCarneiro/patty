import * as R from 'remeda';
import { type Consent, type GrantRequest, SignInDuration } from '../../models/auth/grant.js';
import { CONNECT_PASSWORD_PARAM } from '../../models/auth/origin.js';
import { PASSWORD_MAX_LENGTH } from '../../models/auth/password.js';
import { TokenAccess } from '../../models/auth/token.js';
import { sessionOnlyLabel } from '../../logic/auth/grant.js';
import { ACCESS_LABEL, errorBlock, escapeHtml, fillTemplate, formatMinute } from './auth-pages.js';
import { CONNECT_PATH, UI_APP_CSS_PATH, UI_ROOT_PATH } from './auth-paths.js';
import { readCached, UI_ROOT } from './ui-files.js';

const CONNECT_TEMPLATE_PATH = `${UI_ROOT}/connect.html`;
const CONNECT_RESULT_TEMPLATE_PATH = `${UI_ROOT}/connect-result.html`;

// Typed by the enum, so a new duration cannot exist without a label here — and the radio values the form posts are the
// very values `ConnectFormSchema` accepts.
const SAVED_DURATION_LABEL: Readonly<Record<Exclude<SignInDuration, typeof SignInDuration.enum.session>, string>> = {
  '24h': '24 hours',
  '7d': '7 days',
  '30d': '30 days',
};

const durationLabel = (duration: SignInDuration, clientName: string): string =>
  duration === SignInDuration.enum.session ? sessionOnlyLabel(clientName) : SAVED_DURATION_LABEL[duration];

const radio = (name: string, value: string, label: string, checked: boolean): string =>
  `<label><input type="radio" name="${name}" value="${escapeHtml(value)}"${checked ? ' checked' : ''} required />` +
  `${escapeHtml(label)}</label>`;

const accessOptions = (selected: TokenAccess): string =>
  TokenAccess.options.map((access) => radio('access', access, ACCESS_LABEL[access], access === selected)).join('');

// Only what the asker may have (`logic/auth/grant.ts`'s `offeredDurations`): "this session only" is for a stdio
// process, which has a session to tie the sign-in to, and nothing is above the instance's cap.
const durationOptions = (request: GrantRequest, offered: readonly SignInDuration[], selected: SignInDuration): string =>
  R.map(offered, (duration) =>
    radio('duration', duration, durationLabel(duration, request.clientName), duration === selected),
  ).join('');

export const renderConnectPage = async (fields: Consent & { error?: string }): Promise<string> =>
  fillTemplate(await readCached(CONNECT_TEMPLATE_PATH), {
    stylesheet: UI_APP_CSS_PATH,
    action: CONNECT_PATH,
    // Everything the client reported is escaped: it is whatever the spawning program chose to call itself.
    clientName: escapeHtml(fields.request.clientName),
    clientVersion: escapeHtml(fields.request.clientVersion),
    profile: escapeHtml(fields.request.profile),
    requestedAt: formatMinute(fields.request.createdAt),
    userCode: escapeHtml(fields.request.userCode),
    passwordName: CONNECT_PASSWORD_PARAM,
    passwordMaxLength: String(PASSWORD_MAX_LENGTH),
    accessOptions: accessOptions(fields.choice.access),
    durationOptions: durationOptions(fields.request, fields.durations, fields.choice.duration),
    error: errorBlock(fields.error),
  });

const CLOSE_TAB_HINT = 'You can close this tab.';

// Once a request is answered the page has nothing left to offer: a temporary server (`fintrack login`, or a stdio
// process whose own dashboard could not start) closes as soon as the sign-in is picked up, so a link back to its
// dashboards would be dead moments later. A page that is only an error keeps the way out while the server still lives.
const nextStep = (answered: boolean): string =>
  answered ? `<p>${CLOSE_TAB_HINT}</p>` : `<p><a href="${UI_ROOT_PATH}">Back to the dashboards</a></p>`;

export const renderConnectResultPage = async (fields: {
  heading: string;
  message: string;
  /** The request was approved or denied — nothing more to do here. */
  answered?: boolean;
}): Promise<string> =>
  fillTemplate(await readCached(CONNECT_RESULT_TEMPLATE_PATH), {
    stylesheet: UI_APP_CSS_PATH,
    heading: escapeHtml(fields.heading),
    message: escapeHtml(fields.message),
    next: nextStep(fields.answered ?? false),
  });
