/** The OS keychain could not be read — as opposed to holding nothing. A locked or missing keychain must not look like
 *  "not signed in" to a command that is about to tell a person they are signed out. */
export class KeychainUnavailableError extends Error {
  constructor(cause: unknown) {
    super(
      'the OS keychain is unavailable, so whether this profile is signed in could not be checked — unlock it and try again',
      { cause },
    );
    this.name = 'KeychainUnavailableError';
  }
}
