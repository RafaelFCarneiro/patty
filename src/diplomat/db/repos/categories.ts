import * as categoryAdapters from '../../../adapters/categories.js'
import type { Category } from '../../../models/category.js'
import type { Db } from '../driver.js'
import { categories } from '../schema.js'

export type CategoriesRepo = {
  list: () => Promise<Category[]>
  create: (category: Category) => Promise<Category>
}

export const categoriesRepo = (db: Db): CategoriesRepo => ({
  list: async () => {
    const rows = await db.select().from(categories).orderBy(categories.name)
    return rows.map(categoryAdapters.dbToModel)
  },

  create: async (category) => {
    const [row] = await db
      .insert(categories)
      .values({ id: category.id, name: category.name, kind: category.kind })
      .returning()
    return categoryAdapters.dbToModel(row!)
  },
})
