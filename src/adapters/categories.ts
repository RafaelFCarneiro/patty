import { Category, SubCategory } from '../models/category.js'
import type { CreateCategory } from '../models/category.js'
import type * as wireIn from '../wire/in/categories.js'

export const dbToModel = (record: Record<string, unknown>): Category =>
  Category.parse({ id: record['id'], name: record['name'], kind: record['kind'] })

export const dbToSubCategory = (record: Record<string, unknown>): SubCategory =>
  SubCategory.parse({
    id:         record['id'],
    name:       record['name'],
    parentId:   record['parent_id'],
    parentName: record['parent_name'],
    kind:       record['kind'],
  })

export const wireInToModel = (input: wireIn.CreateCategory): CreateCategory => input
