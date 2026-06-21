import { isNull } from 'drizzle-orm'
import * as categoryAdapters from '../../../adapters/categories.js'
import { expectPresent } from '../../../common/present.js'
import type { Category } from '../../../models/category.js'
import type { Db } from '../driver.js'
import { categories } from '../schema.js'

export type ListCategoriesOptions = {
  orderBy?: 'name'
}

export type CategoriesRepo = {
  list: (options?: ListCategoriesOptions) => Promise<Category[]>
  create: (category: Category) => Promise<Category>
}

export const categoriesRepo = (db: Db): CategoriesRepo => ({
  /** Top-level categories only — sub-categories (parent_id set) belong to subCategoriesRepo. */
  list: async (options) => {
    const query = db.select().from(categories).where(isNull(categories.parentId))
    const rows = options?.orderBy === 'name'
      ? await query.orderBy(categories.name)
      : await query
    return rows.map(categoryAdapters.dbToModel)
  },

  create: async (category) => {
    const [row] = await db
      .insert(categories)
      .values({ id: category.id, name: category.name, kind: category.kind, names: category.names ? JSON.stringify(category.names) : null })
      .returning()
    return categoryAdapters.dbToModel(expectPresent(row, 'categories: row not found after insert'))
  },
})
