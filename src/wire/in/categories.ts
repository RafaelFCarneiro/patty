import { z } from 'zod'
import { Category } from '../../models/category.js'
import { CategoryKind } from '../../models/category.js'

export const CreateCategory = Category.omit({ id: true }).extend({
  kind: CategoryKind.default('expense'),
})
export type CreateCategory = z.infer<typeof CreateCategory>
