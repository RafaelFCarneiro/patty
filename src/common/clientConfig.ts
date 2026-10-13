/** A client's configuration file could not be read or written. `message` is the complete, printable diagnosis. */
export class ClientConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ClientConfigError';
  }
}
