import { Category } from '../models/category.js'

type NodeLike = { properties: Record<string, unknown> }
const props = (v: unknown): Record<string, unknown> => (v as NodeLike).properties

export const dbToModel = (record: Record<string, unknown>): Category =>
  Category.parse(props(record['c']))
