import { eq, isNull, or, sql } from 'drizzle-orm'
import * as categoryAdapters from '../../../adapters/categories.js'
import { expectPresent } from '../../../common/present.js'
import type { Category } from '../../../models/category.js'
import type { Db } from '../driver.js'
import { categories, merchantCategory, recurringRules, transactions } from '../schema.js'

export type ListCategoriesOptions = {
  orderBy?: 'name'
}

export type BlockingReferences = { transactions: number; recurring: number; subCategories: number }

export type CategoriesRepo = {
  list: (options?: ListCategoriesOptions) => Promise<Category[]>
  create: (category: Category) => Promise<Category>
  countReferences: (categoryId: string) => Promise<BlockingReferences>
  delete: (categoryId: string) => Promise<void>
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

  countReferences: async (categoryId) => {
    const [txRow] = await db
      .select({ count: sql<number>`count(*)` })
      .from(transactions)
      .where(or(eq(transactions.categoryId, categoryId), eq(transactions.subcategoryId, categoryId)))
    const [recRow] = await db
      .select({ count: sql<number>`count(*)` })
      .from(recurringRules)
      .where(eq(recurringRules.categoryId, categoryId))
    const [subRow] = await db
      .select({ count: sql<number>`count(*)` })
      .from(categories)
      .where(eq(categories.parentId, categoryId))
    return {
      transactions: txRow?.count ?? 0,
      recurring: recRow?.count ?? 0,
      subCategories: subRow?.count ?? 0,
    }
  },

  delete: async (categoryId) => {
    await db.transaction(async (tx) => {
      await tx.delete(merchantCategory).where(eq(merchantCategory.categoryId, categoryId))
      await tx.delete(categories).where(eq(categories.id, categoryId))
    })
  },
})
