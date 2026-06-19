import { z } from 'zod'
import { Id } from './common.js'

export const CategoryKind = z.enum(['expense', 'income', 'both'])
export type CategoryKind = z.infer<typeof CategoryKind>

/**
 * The 15 canonical default-category slugs — the stable identity of the seeded taxonomy.
 * Single source of truth: the seed (`bootstrap.ts`), the i18n key set (`logic/i18n.ts`), and
 * the default merchant rules (`models/merchantRule.ts`) all key off these. Display names are
 * resolved per locale (Design 002); the slug never changes.
 */
export const DefaultCategoryId = z.enum([
  'cat-food',
  'cat-transport',
  'cat-housing',
  'cat-utilities',
  'cat-health',
  'cat-education',
  'cat-leisure',
  'cat-shopping',
  'cat-subscriptions',
  'cat-travel',
  'cat-taxes',
  'cat-salary',
  'cat-extra-income',
  'cat-investments',
  'cat-other',
])
export type DefaultCategoryId = z.infer<typeof DefaultCategoryId>

export const Category = z.object({
  id: Id,
  name: z.string().min(1),
  kind: CategoryKind,
  i18nKey: z.string().nullish(),
})
export type Category = z.infer<typeof Category>

export type CreateCategory = {
  name: string
  kind: CategoryKind
}

/** Sub-category read projection — includes parent info joined from [:BELONGS_TO]->(:Category). */
export const SubCategory = z.object({
  id: Id,
  name: z.string().min(1),
  parentId: Id,
  parentName: z.string().min(1),
  kind: CategoryKind,
})
export type SubCategory = z.infer<typeof SubCategory>

export type CreateSubCategory = {
  id: string
  name: string
  parentId: string
}
