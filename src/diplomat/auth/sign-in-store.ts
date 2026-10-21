import { ResultAsync } from 'neverthrow';
import type { SignInStore } from '../../controllers/deps.js';
import { KEYCHAIN_SERVICE, keychainFailures, type KeychainFailure } from '../../models/auth/sign-in.js';

/** The OS keychain, one entry per profile and database (ADR-034 §2). */

// The only other place besides the database key's that loads the native keychain module, and lazily, so a
// run that never signs in never loads it.
const loadKeyring = () => import('@napi-rs/keyring');

type Entry = Awaited<ReturnType<typeof loadKeyring>>['Entry']['prototype'];

/** The one place the throwing native module is called: whatever it does with an entry becomes a `Result`. */
const useEntry = <T>(account: string, action: (entry: Entry) => T): ResultAsync<T, KeychainFailure> =>
  ResultAsync.fromPromise(
    loadKeyring().then(({ Entry }) => action(new Entry(KEYCHAIN_SERVICE, account))),
    keychainFailures.unavailable,
  );

export const keychainSignInStore = (
  account: string,
  report: (message: string) => void = console.error,
): SignInStore => ({
  load: () => useEntry(account, (entry) => entry.getPassword() ?? null),

  save: (token) =>
    useEntry(account, (entry) => entry.setPassword(token)).match(
      () => true,
      () => {
        report('fintrack: could not save the sign-in to the OS keychain; it will last only until this process exits.');
        return false;
      },
    ),

  // Nothing saved, or the keychain is unavailable: either way there is nothing left to remove.
  clear: () =>
    useEntry(account, (entry) => entry.deletePassword()).match(
      () => undefined,
      () => undefined,
    ),
});
