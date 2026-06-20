/** Pure name → entity resolution with structured outcomes the AI agent can act on. */

export type Named = { id: string; name: string }

export type Resolution<T extends Named> =
  | { kind: 'found'; entity: T }
  | { kind: 'none'; query: string; candidates: string[] }
  | { kind: 'ambiguous'; query: string; candidates: string[] }

export const fold = (s: string): string =>
  s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim()

export const resolveByName = <T extends Named>(entities: readonly T[], query: string): Resolution<T> => {
  const q = fold(query)
  const exact = entities.filter((e) => fold(e.name) === q)
  if (exact.length === 1) return { kind: 'found', entity: exact[0]! }
  if (exact.length > 1) return { kind: 'ambiguous', query, candidates: exact.map((e) => e.name) }

  const partial = entities.filter((e) => fold(e.name).includes(q) || q.includes(fold(e.name)))
  if (partial.length === 1) return { kind: 'found', entity: partial[0]! }
  if (partial.length > 1) return { kind: 'ambiguous', query, candidates: partial.map((e) => e.name) }

  return { kind: 'none', query, candidates: entities.map((e) => e.name) }
}

/** Like resolveByName, but also checks synonym names for each entity. */
export const resolveByNames = <T extends Named>(
  entities: readonly T[],
  query: string,
  synonyms: (entity: T) => string[],
): Resolution<T> => {
  const primary = resolveByName(entities, query)
  if (primary.kind !== 'none') return primary

  const q = fold(query)
  const withFolded = entities.map((e) => ({ entity: e, folded: synonyms(e).map(fold) }))

  const matches = withFolded.filter(({ folded }) => folded.some((fs) => fs === q))
  if (matches.length === 1) return { kind: 'found', entity: matches[0]!.entity }
  if (matches.length > 1) return { kind: 'ambiguous', query, candidates: matches.map(({ entity }) => entity.name) }

  const partialMatches = withFolded.filter(({ folded }) =>
    folded.some((fs) => fs.includes(q) || q.includes(fs)),
  )
  if (partialMatches.length === 1) return { kind: 'found', entity: partialMatches[0]!.entity }
  if (partialMatches.length > 1) return { kind: 'ambiguous', query, candidates: partialMatches.map(({ entity }) => entity.name) }

  return primary
}
