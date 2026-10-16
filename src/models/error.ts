/** Shared error primitives — domain vocabulary reused across entity models. */

import type { Remedy } from './remedy.js';

export type NotFound<E extends string> = E extends E
  ? { code: `unknown_${E}`; query: string; candidates: string[] }
  : never;
export type Ambiguous<E extends string> = E extends E
  ? { code: `ambiguous_${E}`; query: string; candidates: string[] }
  : never;
export type DuplicateName<E extends string> = E extends E ? { code: 'duplicate_name'; entity: E; name: string } : never;
export type InUse<E extends string, R> = E extends E
  ? { code: 'in_use'; entity: E; name: string; references: R }
  : never;
/** `remedy` (optional) names the domain operation to use instead; each edge turns it into a `hint` in its own words. */
export type ValidationError = { code: 'validation'; issues: string[]; remedy?: Remedy };

export const validation = (issues: string[]): ValidationError => ({ code: 'validation', issues });

/** A validation failure whose fix is another operation: neutral message, plus the `remedy` to use instead. */
export const validationWithRemedy = (message: string, remedy: Remedy): ValidationError => ({
  code: 'validation',
  issues: [message],
  remedy,
});

/** Generic optimistic-concurrency failure (ADR-021): the versioned unit of work exhausted its
 *  retries because a concurrent write kept changing the entity's `version` out from under it.
 *  Carries no business payload by design — the shell that raises it has zero knowledge of which
 *  business process the retried flow represents. */
export type Conflict = { code: 'conflict' };
export const conflict: Conflict = { code: 'conflict' };

export const notFound = <E extends string>(entity: E, query: string, candidates: string[]) =>
  ({ code: `unknown_${entity}` as const, query, candidates }) as NotFound<E>;

export const ambiguous = <E extends string>(entity: E, query: string, candidates: string[]) =>
  ({ code: `ambiguous_${entity}` as const, query, candidates }) as Ambiguous<E>;

/** The words of whatever was thrown: an `Error`'s message, else the value as text. */
export const reasonOf = (cause: unknown): string => (cause instanceof Error ? cause.message : String(cause));
