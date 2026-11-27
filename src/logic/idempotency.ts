import { createHash } from 'node:crypto';

/** JSON, not a separator join: a free-text field (a discriminator, a description) could otherwise forge a field
 *  boundary, and `null` stays distinct from an empty string. */
export const joinUnambiguously = (fields: readonly unknown[]): string => JSON.stringify(fields);

export const keyOf = (fields: readonly unknown[]): string =>
  createHash('sha256').update(joinUnambiguously(fields)).digest('hex');
