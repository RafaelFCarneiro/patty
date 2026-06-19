import { Category, LocalizedNames, SubCategory } from '../models/category.js'
import type { CreateCategory } from '../models/category.js'
import { SubCategoryRowSchema, type CategoryRow } from '../wire/db/categories.js'
import type * as wireIn from '../wire/in/categories.js'

// Input is the schema-derived Drizzle row; Category.parse enforces domain constraints.
export const dbToModel = (row: CategoryRow): Category => {
  let parsed: unknown = null
  if (row.names) {
    try { parsed = JSON.parse(row.names) } catch { throw new Error(`Invalid JSON in categories.names for row ${row.id}`) }
  }
  const names = LocalizedNames.parse(parsed)
  return Category.parse({ id: row.id, name: row.name, kind: row.kind, names })
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
