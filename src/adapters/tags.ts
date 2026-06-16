import { Tag } from '../models/tag.js'
import { TagRowSchema } from '../wire/db/tags.js'

export const dbToModel = (record: Record<string, unknown>): Tag => {
  const row = TagRowSchema.parse(record)
  return Tag.parse({ id: row.id, name: row.name })
}
