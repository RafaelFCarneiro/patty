import { z } from 'zod';
import { NPX_COMMAND, PACKAGE_NAME } from './package.js';

/** A database that a newer build has migrated: an expected failure, not an exception (ADR-034 §7). */
export const DatabaseAheadCode = z.enum(['database_ahead']);
export type DatabaseAhead = { code: typeof DatabaseAheadCode.enum.database_ahead; version: string };

export const databaseErrors = {
  ahead: (version: string): DatabaseAhead => ({ code: DatabaseAheadCode.enum.database_ahead, version }),
};

/** `npm ls -g` is the check for the stale global install that made an old build run in the first place. */
export const STALE_GLOBAL_CHECK_COMMAND = `npm ls -g ${PACKAGE_NAME}`;

/**
 * What an older build says when it finds a database migrated by a newer one, and why it refuses to go on (ADR-034 §7):
 * it would run against a schema it does not know — and might seed or write into it. The one wording, no paths and no
 * keys, shared by the server and every CLI command.
 */
export const databaseAheadMessage = (buildVersion: string): string =>
  `patty: this build (v${buildVersion}) is older than your database (it has migrations this version doesn't ` +
  `know). Update with \`${NPX_COMMAND}\`, or check for a stale global install: \`${STALE_GLOBAL_CHECK_COMMAND}\`.`;

export type DatabaseState = 'ok' | 'error';

export type Health = { status: 'ok'; db: DatabaseState };
