import { z } from 'zod';
import { reasonOf } from '../error.js';
import { SECOND_MS } from './time.js';

/** How often a pending sign-in is checked for its approval. */
export const GRANT_POLL_INTERVAL_MS = 2 * SECOND_MS;

export const CLIENT_NAME_MAX_LENGTH = 80;
export const CLIENT_VERSION_MAX_LENGTH = 32;
export const PROFILE_MAX_LENGTH = 64;
export const DEFAULT_PROFILE = 'default';
export const UNKNOWN_CLIENT_NAME = 'Unknown MCP client';
export const UNKNOWN_CLIENT_VERSION = 'unknown';
export const CLI_CLIENT_NAME = 'fintrack login';

/** The consent page's wording for the memory-only duration: it names the client that asked, if it said who it was. */
export const SESSION_ONLY_LABEL = {
  named: (clientName: string) => `This ${clientName} session only`,
  unnamed: 'This session only',
} as const;

/** `FINTRACK_PROFILE` names which saved sign-in a stdio process uses; it ends up in a keychain account name. */
export const ProfileSchema = z
  .string()
  .trim()
  .min(1)
  .max(PROFILE_MAX_LENGTH)
  .regex(/^[A-Za-z0-9._-]+$/, 'profile may contain letters, digits and . _ -');

export const TOKEN_ENV_VAR = 'FINTRACK_TOKEN';
export const PROFILE_ENV_VAR = 'FINTRACK_PROFILE';

/** The OS keychain entry of a saved sign-in: service `fintrack` (shared with the database key), account
 *  `signin:<profile>:<dbId>` — `dbId` makes a development database and a production one keep apart. */
export const KEYCHAIN_SERVICE = 'fintrack';

export const DB_KEY_KEYCHAIN_ACCOUNT = 'db-encryption-key';
export const SIGN_IN_ACCOUNT_PREFIX = 'signin';
export const DB_ID_LENGTH = 12;

/** The OS keychain could not be read — as opposed to holding nothing. A locked or missing keychain must not look like
 *  "not signed in" to a command that is about to tell a person they are signed out. */
export const KeychainFailureCode = z.enum(['keychain_unavailable']);
export type KeychainFailure = { code: typeof KeychainFailureCode.enum.keychain_unavailable; reason: string };

export const keychainFailures = {
  unavailable: (cause: unknown): KeychainFailure => ({
    code: KeychainFailureCode.enum.keychain_unavailable,
    reason: reasonOf(cause),
  }),
};
