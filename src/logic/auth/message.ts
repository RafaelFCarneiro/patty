import { STDIO_MESSAGES, TERMINAL_SETUP_HINT } from '../../models/auth/message.js';
import { connectUrl } from './origin.js';

export const setupBanner = (fields: { code: string; setupUrl: string; expiresAt: string }): string =>
  [
    '',
    '┌─ patty: first-time setup ─────────────────────────────────────────',
    '│ This instance has no login yet. Claim it with this one-time setup code:',
    '│',
    `│     ${fields.code}`,
    '│',
    `│ Open ${fields.setupUrl} and enter the code, then choose a username and password,`,
    `│ ${TERMINAL_SETUP_HINT}.`,
    `│ The code expires at ${fields.expiresAt} and is replaced by a new one on every restart.`,
    '└──────────────────────────────────────────────────────────────────────',
    '',
  ].join('\n');

export const notSignedInMessage = (fields: {
  origin: string | null;
  userCode: string | null;
  ownerUnclaimed: boolean;
}): string => {
  const base =
    fields.origin !== null && fields.userCode !== null
      ? STDIO_MESSAGES.notSignedIn(connectUrl(fields.origin, fields.userCode), fields.userCode)
      : STDIO_MESSAGES.notSignedInWithoutHttp;
  return fields.ownerUnclaimed ? `${base}${STDIO_MESSAGES.ownerUnclaimedHint}` : base;
};
