import { Tag } from '../models/tag.js'
import type { TagRow } from '../wire/db/tags.js'

// Input is the schema-derived Drizzle row; Tag.parse enforces domain constraints.
export const dbToModel = (row: TagRow): Tag =>
  Tag.parse({ id: row.id, name: row.name })
