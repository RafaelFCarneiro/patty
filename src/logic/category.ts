import { purry } from 'remeda'
import { localizeCategoryKind } from './labels.js'
import { fold } from './resolve.js'
import type { Category } from '../models/category.js'
import type { Locale } from '../models/locale.js'

type HasKind = { kind: Category['kind'] }

const _withKindLabel = <T extends HasKind>(item: T, locale: Locale): T => ({
  ...item,
  kindLabel: localizeCategoryKind(item.kind, locale),
})

export function withKindLabel<T extends HasKind>(item: T, locale: Locale): T
export function withKindLabel(locale: Locale): <T extends HasKind>(item: T) => T
export function withKindLabel(...args: readonly unknown[]) {
  return purry(_withKindLabel, args)
}

export const resolveDisplayName = (cat: Category, locale: string): Category => ({
  ...cat,
  name: cat.names?.[locale] ?? cat.name,
})

export const allNames = (cat: Category): readonly string[] => [
  cat.name,
  ...Object.values(cat.names ?? {}),
]

export const hasNameCollision = (categories: readonly Category[], name: string): boolean => {
  const folded = fold(name)
  return categories.some((c) => allNames(c).some((n) => fold(n) === folded))
}

export const resolveAndSort = (categories: readonly Category[], locale: string): Category[] => {
  const resolved = categories.map((c) => resolveDisplayName(c, locale))
  const collator = new Intl.Collator(locale, { sensitivity: 'base' })
  return resolved.sort((a, b) => collator.compare(a.name, b.name))
}

export const buildSynonyms = (
  rawCategories: readonly Category[],
): (cat: Category) => string[] => {
  const canonicalById = new Map(rawCategories.map((c) => [c.id, c.name]))
  return (cat) => [
    ...(canonicalById.has(cat.id) ? [canonicalById.get(cat.id)!] : []),
    ...Object.values(cat.names ?? {}),
  ]
}
