import { Tag } from '../models/tag.js'

export const dbToModel = (record: Record<string, unknown>): Tag =>
  Tag.parse({ id: record['id'], name: record['name'] })
