import type { Driver } from 'neo4j-driver'
import { toCategory } from '../../../adapters/records.js'
import type { Category } from '../../../models/category.js'
import { run } from '../driver.js'

export type CategoriesRepo = {
  list: () => Promise<Category[]>
  create: (category: Category) => Promise<Category>
}

export const categoriesRepo = (driver: Driver): CategoriesRepo => ({
  list: async () => {
    const rows = await run(driver, 'MATCH (c:Category) RETURN c ORDER BY c.name')
    return rows.map(toCategory)
  },

  create: async (category) => {
    const rows = await run(
      driver,
      'CREATE (c:Category {id: $id, name: $name, kind: $kind}) RETURN c',
      { ...category },
    )
    return toCategory(rows[0]!)
  },
})
