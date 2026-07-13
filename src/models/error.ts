/** Shared error primitives — domain vocabulary reused across entity models. */

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
export type ValidationError = { code: 'validation'; issues: string[] };

export const validation = (issues: string[]): ValidationError => ({ code: 'validation', issues });

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
