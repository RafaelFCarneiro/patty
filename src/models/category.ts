import { z } from 'zod'
import { Id } from './common.js'

export const CategoryKind = z.enum(['expense', 'income', 'both'])
export type CategoryKind = z.infer<typeof CategoryKind>

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
