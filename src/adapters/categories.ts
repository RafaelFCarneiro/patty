import { Category, SubCategory } from '../models/category.js'
import type { CreateCategory } from '../models/category.js'
import type * as wireIn from '../wire/in/categories.js'

type NodeLike = { properties: Record<string, unknown> }
const props = (v: unknown): Record<string, unknown> => (v as NodeLike).properties

export const dbToModel = (record: Record<string, unknown>): Category =>
  Category.parse(props(record['c']))

export const dbToSubCategory = (record: Record<string, unknown>): SubCategory =>
  SubCategory.parse({
    ...props(record['sc']),
    parentId: record['parentId'],
    parentName: record['parentName'],
    kind: record['kind'],
  })

export const wireInToModel = (input: wireIn.CreateCategory): CreateCategory => input
