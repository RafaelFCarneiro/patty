import { purry } from 'remeda';
import { localizeCategoryKind } from './localize.js';
import { fold } from './resolve.js';
import type { Category, CategoryReferences } from '../models/category.js';
import type { Locale } from '../models/locale.js';

type HasKind = { kind: Category['kind'] };

const _withKindLabel = <T extends HasKind>(item: T, locale: Locale): T => ({
  ...item,
  kindLabel: localizeCategoryKind(item.kind, locale),
});

export function withKindLabel<T extends HasKind>(item: T, locale: Locale): T;
export function withKindLabel(locale: Locale): <T extends HasKind>(item: T) => T;
export function withKindLabel(...args: readonly unknown[]) {
  return purry(_withKindLabel, args);
}

export const resolveDisplayName = (cat: Category, locale: string): Category => ({
  ...cat,
  name: cat.names?.[locale] ?? cat.name,
});

export const localizeCategoryName = (
  name: string | null | undefined,
  names: Record<string, string> | null | undefined,
  locale: string,
): string | undefined => (name != null ? (names?.[locale] ?? name) : undefined);

export const allNames = (cat: Category): readonly string[] => [cat.name, ...Object.values(cat.names ?? {})];

export const hasNameCollision = (categories: readonly Category[], name: string): boolean => {
  const folded = fold(name);
  return categories.some((c) => allNames(c).some((n) => fold(n) === folded));
};

export const hasSubCategoryNameCollision = (siblings: readonly { name: string }[], name: string): boolean =>
  siblings.some((s) => s.name.toLowerCase() === name.toLowerCase());

export const assertCategoryNameAvailable = (categories: readonly Category[], name: string): boolean =>
  !hasNameCollision(categories, name);

export const assertSubCategoryNameAvailable = (siblings: readonly { name: string }[], name: string): boolean =>
  !hasSubCategoryNameCollision(siblings, name);

export const isSharedDefault = (row: { shared: boolean }): boolean => row.shared;

export const isCategoryUnreferenced = (refs: CategoryReferences): boolean =>
  refs.transactions === 0 && refs.recurring === 0 && refs.subCategories === 0;

export const resolveAndSort = (categories: readonly Category[], locale: string): Category[] => {
  const resolved = categories.map((c) => resolveDisplayName(c, locale));
  const collator = new Intl.Collator(locale, { sensitivity: 'base' });
  return resolved.sort((a, b) => collator.compare(a.name, b.name));
};

export const buildSynonyms = (rawCategories: readonly Category[]): ((cat: Category) => string[]) => {
  const canonicalById = new Map(rawCategories.map((c) => [c.id, c.name]));
  return (cat) => [
    ...(canonicalById.has(cat.id) ? [canonicalById.get(cat.id)!] : []),
    ...Object.values(cat.names ?? {}),
  ];
};
