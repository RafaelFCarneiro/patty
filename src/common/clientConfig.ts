/** A client's configuration file could not be read or written. `message` is the complete, printable diagnosis. */
export class ClientConfigError extends Error {
  /** `warnings` were raised before the failure and still belong on the screen, ahead of `message`. */
  constructor(
    message: string,
    readonly warnings: readonly string[] = [],
  ) {
    super(message);
    this.name = 'ClientConfigError';
  }
}
