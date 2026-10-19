import { INVITE_PATH } from '../../models/auth/origin.js';
import type { PasswordReset } from '../../models/auth/password.js';
import type { IssuedInvite, RevokedCredentials, UserSummary } from '../../models/auth/users.js';

const endedCredentials = (revoked: RevokedCredentials): string =>
  `sessions ended: ${revoked.sessionsEnded}, tokens and sign-ins revoked: ${revoked.tokensRevoked}`;

/** What the command line says to the person who ran it. */
export const CLI_MESSAGES = {
  ownerClaimed: (username: string) =>
    `Owner claimed: "${username}". Log in to the dashboard (/ui) with this username and your password.`,
  alreadyClaimed: (username: string) => `FinTrack is already set up: the owner is "${username}".`,
  passwordReset: (reset: PasswordReset) => `Password reset for "${reset.username}".`,
  sessionsEnded: (count: number) => `Sessions ended: ${count}`,
  tokensRevoked: (count: number) => `Access tokens revoked: ${count}`,
  resetting: (username: string) => `Choose a new password for "${username}".`,
  noUsers: 'No users.',
  userRow: (user: UserSummary) =>
    [
      (user.username ?? '(not set up yet)').padEnd(24),
      user.role.padEnd(8),
      user.status.padEnd(9),
      `last login: ${user.lastLoginAt ?? 'never'}`,
    ].join(' '),
  invited: (issued: IssuedInvite, link: string | null) =>
    [
      `Invite for "${issued.user.username}" (${issued.user.role}) — valid until ${issued.expiresAt}, single use, shown only now:`,
      link === null
        ? `  Page: ${INVITE_PATH} on the server that runs this database (set PUBLIC_URL to print a link)`
        : `  Link: ${link}`,
      `  Code: ${issued.code}`,
      'They choose their own password; you never see it.',
    ].join('\n'),
  reissueEnded: (revoked: RevokedCredentials) =>
    `Password cleared; ${endedCredentials(revoked)}. The invite is the only way back in.`,
  disabled: (username: string, revoked: RevokedCredentials) => `Disabled "${username}". ${endedCredentials(revoked)}.`,
  enabled: (username: string) =>
    `Enabled "${username}". They can log in again; their earlier sessions, tokens and sign-ins stay revoked.`,
  roleSet: (username: string, role: string) => `"${username}" is now ${role}.`,
  failure: (reason: string) => `fintrack: ${reason}`,
  unexpectedArgument: (argument: string) => `unexpected argument "${argument}"`,
} as const;
