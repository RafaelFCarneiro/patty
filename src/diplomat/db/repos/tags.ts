import { eq } from 'drizzle-orm'
import * as tagAdapters from '../../../adapters/tags.js'
import { expectPresent } from '../../../common/present.js'
import type { Tag } from '../../../models/tag.js'
import type { Db } from '../driver.js'
import { tags } from '../schema.js'

export type TagsRepo = {
  list: () => Promise<Tag[]>
  findByName: (name: string) => Promise<Tag | null>
  /** Returns `null` when a tag with the same name already exists. */
  create: (tag: Tag) => Promise<Tag | null>
  delete: (id: string) => Promise<boolean>
}

export const tagsRepo = (db: Db): TagsRepo => ({
  list: async () => {
    const rows = await db.select().from(tags).orderBy(tags.name)
    return rows.map(tagAdapters.dbToModel)
  },

  findByName: async (name) => {
    const [row] = await db.select().from(tags).where(eq(tags.name, name)).limit(1)
    return row ? tagAdapters.dbToModel(row) : null
  },

  create: async (tag) => {
    const existing = await db.select().from(tags).where(eq(tags.name, tag.name)).limit(1)
    if (existing.length > 0) return null
    const [row] = await db.insert(tags).values({ id: tag.id, name: tag.name }).returning()
    return tagAdapters.dbToModel(expectPresent(row, 'tags: row not found after insert'))
  },

  delete: async (id) => {
    const result = await db.delete(tags).where(eq(tags.id, id))
    return (result.rowsAffected ?? 0) > 0
  },
})
