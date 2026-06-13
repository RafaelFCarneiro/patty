import { Tag } from '../models/tag.js'

type NodeLike = { properties: Record<string, unknown> }

export const dbToModel = (record: Record<string, unknown>): Tag =>
  Tag.parse((record['t'] as NodeLike).properties)
