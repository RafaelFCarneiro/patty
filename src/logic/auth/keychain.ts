import { DB_ID_LENGTH, SIGN_IN_ACCOUNT_PREFIX } from '../../models/auth/sign-in.js';

export const dbIdOf = (dbPathHash: string): string => dbPathHash.slice(0, DB_ID_LENGTH);
export const keychainAccount = (profile: string, dbId: string): string =>
  [SIGN_IN_ACCOUNT_PREFIX, profile, dbId].join(':');
