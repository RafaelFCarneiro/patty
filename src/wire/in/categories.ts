import { z } from 'zod'
import { CategoryKind } from '../../models/category.js'
import type { CreateCategory as Domain, CreateSubCategory as SubDomain } from '../../models/category.js'

export const CreateCategory = z
  .object({
    name: z.string().min(1),
    kind: CategoryKind.optional(),
  })
  .transform((input): Domain => ({
    name: input.name,
    kind: input.kind ?? 'expense',
  }))
export type CreateCategory = z.infer<typeof CreateCategory>

export const CreateSubCategory = z.object({
  name: z.string().min(1),
  parentId: z.string().min(1).describe('ID of the parent category'),
})
export type CreateSubCategory = z.infer<typeof CreateSubCategory>

export const wireSubCategoryInToModel = (input: CreateSubCategory, id: string): SubDomain => ({
  id,
  name: input.name,
  parentId: input.parentId,
})
