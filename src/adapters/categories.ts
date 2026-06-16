import { Category, SubCategory } from '../models/category.js'
import type { CreateCategory } from '../models/category.js'
import { CategoryRowSchema, SubCategoryRowSchema } from '../wire/db/categories.js'
import type * as wireIn from '../wire/in/categories.js'

export const dbToModel = (record: Record<string, unknown>): Category => {
  const row = CategoryRowSchema.parse(record)
  return Category.parse({ id: row.id, name: row.name, kind: row.kind })
}

export const dbToSubCategory = (record: Record<string, unknown>): SubCategory => {
  const row = SubCategoryRowSchema.parse(record)
  return SubCategory.parse({
    id:         row.id,
    name:       row.name,
    parentId:   row.parent_id,
    parentName: row.parent_name,
    kind:       row.kind,
  })
}

export const wireInToModel = (input: wireIn.CreateCategory): CreateCategory => input
