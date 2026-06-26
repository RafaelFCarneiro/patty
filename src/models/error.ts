/** Shared error primitives — domain vocabulary reused across entity models. */

export type NotFound<E extends string> = { code: `unknown_${E}`; query: string; candidates: string[] }
export type Ambiguous<E extends string> = { code: `ambiguous_${E}`; query: string; candidates: string[] }
export type DuplicateName<E extends string> = { code: 'duplicate_name'; entity: E; name: string }
export type InUse<E extends string, R> = { code: 'in_use'; entity: E; name: string; references: R }
export type ValidationError = { code: 'validation'; issues: string[] }

export const validation = (issues: string[]): ValidationError => ({ code: 'validation', issues })

export const notFound = <E extends string>(entity: E, query: string, candidates: string[]): NotFound<E> => ({
  code: `unknown_${entity}`, query, candidates,
})

export const ambiguous = <E extends string>(entity: E, query: string, candidates: string[]): Ambiguous<E> => ({
  code: `ambiguous_${entity}`, query, candidates,
})
