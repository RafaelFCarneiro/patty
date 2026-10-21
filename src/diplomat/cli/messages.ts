import { PRIVATE_FILE_MODE, type ExportedRowCounts } from '../../models/export.js';
import { NPX_COMMAND } from '../../models/package.js';
import { INVITE_PATH } from '../../models/auth/origin.js';
import type { PasswordReset } from '../../models/auth/password.js';
import type { IssuedInvite, RevokedCredentials, UserSummary } from '../../models/auth/users.js';

const MOVE_GUIDE = 'docs/auth.md, "Moving an npm install to Docker"';
const fileMode = (): string => PRIVATE_FILE_MODE.toString(8).padStart(4, '0');

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
  keyExported: (path: string) =>
    [
      `Database key written to ${path} (mode ${fileMode()}, never overwritten).`,
      "Use it as FINTRACK_DB_KEY_FILE, or as the container's fintrack_db_key secret. Keep it away from the data and its backups.",
      `Next: ${NPX_COMMAND} db export --to <file>, then follow ${MOVE_GUIDE}.`,
    ].join('\n'),
  snapshotExported: (path: string, counts: ExportedRowCounts) =>
    [
      `Database snapshot written to ${path} (mode ${fileMode()}, encrypted under the same key, never overwritten).`,
      `Rows (whole database, every user): ${Object.entries(counts)
        .map(([table, rows]) => `${table} ${rows}`)
        .join(', ')}`,
      `Compare these after the move: ${MOVE_GUIDE}.`,
    ].join('\n'),
  destinationExists: (path: string) => `${path} already exists; choose a new file (an export never overwrites)`,
  destinationDirectoryMissing: (path: string) => `the directory of ${path} does not exist`,
  keyBesideData: (directory: string) =>
    `${directory} holds (or contains) the database; the key must never sit next to the data it unlocks. Choose another directory`,
  snapshotIsDatabase: (path: string) => `${path} is the database itself; choose another file`,
  failure: (reason: string) => `fintrack: ${reason}`,
  unexpectedArgument: (argument: string) => `unexpected argument "${argument}"`,
} as const;
