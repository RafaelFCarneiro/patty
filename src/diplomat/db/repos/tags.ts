import { Neo4jError, type Driver } from 'neo4j-driver'
import * as tagAdapters from '../../../adapters/tags.js'
import type { Tag } from '../../../models/tag.js'
import { run } from '../driver.js'

export type TagsRepo = {
  list: () => Promise<Tag[]>
  findByName: (name: string) => Promise<Tag | null>
  /** Returns `null` when a tag with the same name already exists. */
  create: (tag: Tag) => Promise<Tag | null>
  delete: (id: string) => Promise<boolean>
}

const isConstraintError = (e: unknown): boolean =>
  e instanceof Neo4jError && e.code === 'Neo.ClientError.Schema.ConstraintValidationFailed'

export const tagsRepo = (driver: Driver): TagsRepo => ({
  list: async () => {
    const rows = await run(driver, 'MATCH (t:Tag) RETURN t ORDER BY t.name')
    return rows.map(tagAdapters.dbToModel)
  },

  findByName: async (name) => {
    const rows = await run(
      driver,
      'MATCH (t:Tag {name: $name}) RETURN t LIMIT 1',
      { name },
    )
    return rows[0] ? tagAdapters.dbToModel(rows[0]) : null
  },

  create: async (tag) => {
    try {
      const rows = await run(
        driver,
        'CREATE (t:Tag {id: $id, name: $name}) RETURN t',
        { ...tag },
      )
      return tagAdapters.dbToModel(rows[0]!)
    } catch (e: unknown) {
      if (isConstraintError(e)) return null
      throw e
    }
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
