import type { Driver } from 'neo4j-driver'
import * as tagAdapters from '../../../adapters/tags.js'
import type { Tag } from '../../../models/tag.js'
import { run } from '../driver.js'

export type TagsRepo = {
  list: () => Promise<Tag[]>
  findByName: (name: string) => Promise<Tag | null>
  create: (tag: Tag) => Promise<Tag>
  delete: (id: string) => Promise<boolean>
}

export const tagsRepo = (driver: Driver): TagsRepo => ({
  list: async () => {
    const rows = await run(driver, 'MATCH (t:Tag) RETURN t ORDER BY t.name')
    return rows.map(tagAdapters.dbToModel)
  },

  findByName: async (name) => {
    const rows = await run(
      driver,
      'MATCH (t:Tag) WHERE toLower(t.name) = toLower($name) RETURN t LIMIT 1',
      { name },
    )
    return rows[0] ? tagAdapters.dbToModel(rows[0]) : null
  },

  create: async (tag) => {
    const rows = await run(
      driver,
      'CREATE (t:Tag {id: $id, name: $name}) RETURN t',
      { ...tag },
    )
    return tagAdapters.dbToModel(rows[0]!)
  },

  delete: async (id) => {
    const rows = await run(
      driver,
      'MATCH (t:Tag {id: $id}) DETACH DELETE t RETURN count(t) AS deleted',
      { id },
    )
    return Number(rows[0]?.['deleted'] ?? 0) > 0
  },
})
