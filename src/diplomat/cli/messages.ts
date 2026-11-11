import { PRIVATE_FILE_MODE, type ExportedRowCounts } from '../../models/export.js';
import { DB_KEY_KEYCHAIN_ACCOUNT, KEYCHAIN_SERVICE } from '../../models/auth/sign-in.js';
import { AUTH_MESSAGES, TERMINAL_SETUP_HINT } from '../../models/auth/message.js';
import { EXPORT_DECLINED_CODE, USERS_UNREADABLE_CODE, type KeyExportStop } from '../../models/auth/key-export.js';
import { KeyImportRefusal } from '../../models/key-import.js';
import { LOG_PREFIX, NPX_COMMAND, PRODUCT_NAME } from '../../models/package.js';
import { INVITE_PATH } from '../../models/auth/origin.js';
import type { PasswordReset } from '../../models/auth/password.js';
import type { IssuedInvite, RevokedCredentials, UserSummary } from '../../models/auth/users.js';

const MOVE_GUIDE = 'docs/auth.md, "Moving an npm install to Docker"';
const fileMode = (): string => PRIVATE_FILE_MODE.toString(8).padStart(4, '0');

const countsLine = (counts: ExportedRowCounts): string =>
  Object.entries(counts)
    .map(([table, rows]) => `${table} ${rows}`)
    .join(', ');

const KEY_IMPORT_REFUSALS = {
  [KeyImportRefusal.enum.key_file_configured]:
    'PATTY_DB_KEY_FILE is set: this install reads its key from that file, not from the keychain. Unset it to use the keychain',
  [KeyImportRefusal.enum.key_env_configured]:
    'PATTY_DB_KEY is set: this install reads its key from the environment, not from the keychain. Unset it to use the keychain',
  [KeyImportRefusal.enum.keychain_holds_key]:
    `the OS keychain already holds a database key for this install; an import never replaces it. Remove the "${KEYCHAIN_SERVICE}" / "${DB_KEY_KEYCHAIN_ACCOUNT}" keychain entry yourself if you mean to`,
} as const satisfies Record<KeyImportRefusal, string>;

const NOTHING_WRITTEN = 'nothing was written';

const usersUnreadableMessage = (reason: string): string =>
  `cannot read the users of the database (${reason}). If it was last used by an older version, start ${PRODUCT_NAME} once (it migrates the database after its safety copy) and run the export again; ${NOTHING_WRITTEN}`;

const FIXED_STOP_MESSAGES = {
  owner_unclaimed: `no administrator has a login yet, so there is no password to ask for: finish setting up ${PRODUCT_NAME} first ${TERMINAL_SETUP_HINT}`,
  invalid_credentials: `${AUTH_MESSAGES.invalidCredentials} Too many attempts; ${NOTHING_WRITTEN}.`,
  [EXPORT_DECLINED_CODE]: `not confirmed; ${NOTHING_WRITTEN}`,
} as const satisfies Record<Exclude<KeyExportStop['code'], typeof USERS_UNREADABLE_CODE>, string>;

const keyExportStopMessage = (stop: KeyExportStop): string =>
  stop.code === USERS_UNREADABLE_CODE ? usersUnreadableMessage(stop.reason) : FIXED_STOP_MESSAGES[stop.code];

const endedCredentials = (revoked: RevokedCredentials): string =>
  `sessions ended: ${revoked.sessionsEnded}, tokens and sign-ins revoked: ${revoked.tokensRevoked}`;

/** What the command line says to the person who ran it. */
export const CLI_MESSAGES = {
  ownerClaimed: (username: string) =>
    `Owner claimed: "${username}". Log in to the dashboard (/ui) with this username and your password.`,
  alreadyClaimed: (username: string) => `${PRODUCT_NAME} is already set up: the owner is "${username}".`,
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
      "Use it as PATTY_DB_KEY_FILE, or as the container's patty_db_key secret. Keep it away from the data and its backups.",
      `Next: ${NPX_COMMAND} db export --to <file>, then follow ${MOVE_GUIDE}.`,
    ].join('\n'),
  keyExportNeedsTerminal:
    'exporting the database key needs a person at a terminal: run this command in an interactive terminal (it cannot be scripted)',
  keyExportStopped: keyExportStopMessage,
  keyExportWarning: (path: string) =>
    [
      `This writes the key that decrypts your ${PRODUCT_NAME} database to ${path} (mode ${fileMode()}, never overwritten).`,
      'Whoever holds it and a copy of the database can read all your data.',
      'Keep it somewhere safe, never in the same place as a backup of the database, and delete it once you have used it.',
    ].join('\n'),
  snapshotExported: (path: string, counts: ExportedRowCounts) =>
    [
      `Database snapshot written to ${path} (mode ${fileMode()}, encrypted under the same key, never overwritten).`,
      `Rows (whole database, every user): ${countsLine(counts)}`,
      `Compare these after the move: ${MOVE_GUIDE}.`,
    ].join('\n'),
  keyImported: () =>
    [
      'Database key stored in the OS keychain, where the server reads it.',
      `Next: ${NPX_COMMAND} db import --from <snapshot>, then ${NPX_COMMAND} setup <client>.`,
    ].join('\n'),
  snapshotImported: (path: string, counts: ExportedRowCounts) =>
    [
      `Database snapshot imported to ${path} (mode ${fileMode()}, never overwritten). Nothing was migrated: the next start does that, after its usual safety copy.`,
      `Rows (whole database, every user): ${countsLine(counts)}`,
      `Compare these with the export's: ${MOVE_GUIDE}. Next: ${NPX_COMMAND} setup <client>.`,
    ].join('\n'),
  keyImportRefused: (refusal: KeyImportRefusal) => KEY_IMPORT_REFUSALS[refusal],
  keyFileInvalid:
    'the file does not hold a database key: expected 64 hexadecimal characters and at most one trailing newline (no spaces), as `key export` writes it',
  keyDoesNotOpenDatabase: (path: string) => `the key does not open the database at ${path}; nothing was stored`,
  keyDoesNotOpenSnapshot: (path: string) =>
    `${path} does not open with this install's key, or is not a database; nothing was imported`,
  noKeyToImport: `no database key found (PATTY_DB_KEY_FILE, PATTY_DB_KEY or the OS keychain); import the key first: ${NPX_COMMAND} key import --from <file>`,
  snapshotNotStandalone: (path: string) =>
    `${path} is not a standalone snapshot (a -wal or -journal file sits beside it); create one with \`${NPX_COMMAND} db export\``,
  databaseLeftovers: (path: string) =>
    `${path} has a leftover -wal, -shm or -journal file beside it; remove it yourself first, or it would be replayed on the imported database`,
  importSourceMissing: (path: string) => `${path} does not exist or is not a file`,
  importSourceUnreadable: (path: string) => `cannot read ${path}`,
  databaseExists: (path: string) =>
    `a database already exists at ${path}; an import never overwrites it. Move it away yourself if you mean to replace it`,
  destinationExists: (path: string) => `${path} already exists; choose a new file (an export never overwrites)`,
  destinationDirectoryMissing: (path: string) => `the directory of ${path} does not exist`,
  keyBesideData: (directory: string) =>
    `${directory} holds (or contains) the database; the key must never sit next to the data it unlocks. Choose another directory`,
  snapshotIsDatabase: (path: string) => `${path} is the database itself; choose another file`,
  failure: (reason: string) => `${LOG_PREFIX} ${reason}`,
  unexpectedArgument: (argument: string) => `unexpected argument "${argument}"`,
} as const;
