import { DB_ID_LENGTH, SIGN_IN_ACCOUNT_PREFIX } from '../../models/auth/signIn.js';

/** The keychain account of a saved sign-in. `dbId` is the first characters of sha256(absolute DB path), so a
 *  development database and a production one never share a saved sign-in. */
export const dbIdOf = (dbPathHash: string): string => dbPathHash.slice(0, DB_ID_LENGTH);
export const keychainAccount = (profile: string, dbId: string): string =>
  [SIGN_IN_ACCOUNT_PREFIX, profile, dbId].join(':');
