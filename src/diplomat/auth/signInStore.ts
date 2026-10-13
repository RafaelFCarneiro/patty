import type { SignInStore } from '../../controllers/deps.js';
import { KeychainUnavailableError } from '../../common/keychain.js';
import { KEYCHAIN_SERVICE } from '../../models/auth/signIn.js';

/** The OS keychain, one entry per profile and database (ADR-034 §2). */

// The only other place besides the database key's that loads the native keychain module, and lazily, so a
// run that never signs in never loads it.
const loadKeyring = () => import('@napi-rs/keyring');

const entryFor = async (account: string) => {
  const { Entry } = await loadKeyring();
  return new Entry(KEYCHAIN_SERVICE, account);
};

export const keychainSignInStore = (
  account: string,
  report: (message: string) => void = console.error,
): SignInStore => ({
  load: async () => {
    try {
      return (await entryFor(account)).getPassword() ?? null;
    } catch (cause) {
      throw new KeychainUnavailableError(cause);
    }
  },

  save: async (token) => {
    try {
      (await entryFor(account)).setPassword(token);
      return true;
    } catch {
      report('fintrack: could not save the sign-in to the OS keychain; it will last only until this process exits.');
      return false;
    }
  },

  clear: async () => {
    try {
      (await entryFor(account)).deletePassword();
    } catch {
      // Nothing saved, or the keychain is unavailable: either way there is nothing left to remove.
    }
  },
});
