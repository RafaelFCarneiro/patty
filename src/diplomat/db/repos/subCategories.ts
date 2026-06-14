import type { Driver } from 'neo4j-driver'
import * as categoryAdapters from '../../../adapters/categories.js'
import type { SubCategory, CreateSubCategory } from '../../../models/category.js'
import { run } from '../driver.js'

export type SubCategoriesRepo = {
  list: () => Promise<SubCategory[]>
  listByParent: (parentId: string) => Promise<SubCategory[]>
  findByName: (name: string) => Promise<SubCategory | null>
  create: (input: CreateSubCategory) => Promise<SubCategory>
}

export const subCategoriesRepo = (driver: Driver): SubCategoriesRepo => ({
  list: async () => {
    const rows = await run(
      driver,
      `MATCH (sc:SubCategory)-[:BELONGS_TO]->(c:Category)
       RETURN sc, c.id AS parentId, c.name AS parentName, c.kind AS kind
       ORDER BY c.name, sc.name`,
    )
    return rows.map(categoryAdapters.dbToSubCategory)
  },

  listByParent: async (parentId) => {
    const rows = await run(
      driver,
      `MATCH (sc:SubCategory)-[:BELONGS_TO]->(c:Category {id: $parentId})
       RETURN sc, c.id AS parentId, c.name AS parentName, c.kind AS kind
       ORDER BY sc.name`,
      { parentId },
    )
    return rows.map(categoryAdapters.dbToSubCategory)
  },

  findByName: async (name) => {
    const rows = await run(
      driver,
      `MATCH (sc:SubCategory {name: $name})-[:BELONGS_TO]->(c:Category)
       RETURN sc, c.id AS parentId, c.name AS parentName, c.kind AS kind
       LIMIT 1`,
      { name },
    )
    return rows[0] ? categoryAdapters.dbToSubCategory(rows[0]) : null
  },

  create: async ({ id, name, parentId }) => {
    const rows = await run(
      driver,
      `MATCH (c:Category {id: $parentId})
       CREATE (sc:SubCategory {id: $id, name: $name})
       MERGE (sc)-[:BELONGS_TO]->(c)
       RETURN sc, c.id AS parentId, c.name AS parentName, c.kind AS kind`,
      { id, name, parentId },
    )
    return categoryAdapters.dbToSubCategory(rows[0]!)
  },
})
