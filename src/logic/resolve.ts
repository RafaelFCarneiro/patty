/** Pure name → entity resolution with structured outcomes the AI agent can act on. */

import * as R from 'remeda'

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

const toResolution = <T extends Named>(
  matches: readonly T[],
  query: string,
  allCandidates: readonly T[],
): Resolution<T> => {
  const single = R.first(matches)
  if (single && matches.length === 1) return { kind: 'found', entity: single }
  if (matches.length > 1) return { kind: 'ambiguous', query, candidates: R.map(matches, (e) => e.name) }
  return { kind: 'none', query, candidates: R.map(allCandidates, (e) => e.name) }
}

export const resolveByName = <T extends Named>(entities: readonly T[], query: string): Resolution<T> => {
  const q = fold(query)
  const exact = entities.filter((e) => fold(e.name) === q)
  const exactResult = toResolution(exact, query, entities)
  if (exactResult.kind !== 'none') return exactResult

  const partial = entities.filter((e) => { const fn = fold(e.name); return fn.includes(q) || q.includes(fn) })
  return toResolution(partial, query, entities)
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
  const withFolded = R.map(entities, (e) => ({ entity: e, folded: R.map(synonyms(e), fold) }))

  const exactMatches = withFolded.filter(({ folded }) => folded.some((fs) => fs === q))
  const exactFirst = R.first(exactMatches)
  if (exactFirst && exactMatches.length === 1) return { kind: 'found', entity: exactFirst.entity }
  if (exactMatches.length > 1) return { kind: 'ambiguous', query, candidates: R.map(exactMatches, ({ entity }) => entity.name) }

  const partialMatches = withFolded.filter(({ folded }) =>
    folded.some((fs) => fs.includes(q) || q.includes(fs)),
  )
  const partialFirst = R.first(partialMatches)
  if (partialFirst && partialMatches.length === 1) return { kind: 'found', entity: partialFirst.entity }
  if (partialMatches.length > 1) return { kind: 'ambiguous', query, candidates: R.map(partialMatches, ({ entity }) => entity.name) }

  return primary
}
