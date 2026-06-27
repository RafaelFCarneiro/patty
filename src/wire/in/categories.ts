import type { z } from 'zod'
import { CategoryKind } from '../../models/category.js'
import * as modelCategory from '../../models/category.js'

// The boundary owns quality-of-life defaults; the domain keeps these fields required (not-null).
// Default kind is the most common category usage.
export const CreateCategorySchema = modelCategory.CreateCategorySchema.extend({
  kind: modelCategory.CreateCategorySchema.shape.kind.default(CategoryKind.enum.expense),
})
export type CreateCategory = z.infer<typeof CreateCategorySchema>

export const CreateSubCategorySchema = modelCategory.CreateSubCategorySchema.omit({ id: true })
export type CreateSubCategory = z.infer<typeof CreateSubCategorySchema>
