/**
 * Assert a value the code path guarantees is present — e.g. a row read back
 * immediately after the INSERT/UPDATE that created it. Throws (→ unexpected error,
 * surfaced as a 500) with a traceable message instead of a silent `value!`
 * non-null assertion, so an invariant violation fails loudly rather than
 * propagating `undefined` into the domain.
 */
export const expectPresent = <T>(value: T | null | undefined, message: string): T => {
  if (value == null) throw new Error(message);
  return value;
};

/** Shared `expectPresent` message shape for a row re-read immediately after the write that created it. */
export const rowNotFoundAfterWrite = (table: string, verb: string): string => `${table}: row not found after ${verb}`;
