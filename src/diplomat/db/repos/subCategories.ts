import { eq, or, sql } from 'drizzle-orm'
import * as categoryAdapters from '../../../adapters/categories.js'
import { expectPresent } from '../../../common/present.js'
import type { SubCategory, CreateSubCategory } from '../../../models/category.js'
import type { BlockingReferences } from './categories.js'
import type { Db } from '../driver.js'
import { categories, merchantCategory, recurringRules, transactions } from '../schema.js'

export type SubCategoriesRepo = {
  list: () => Promise<SubCategory[]>
  listByParent: (parentId: string) => Promise<SubCategory[]>
  findByName: (name: string) => Promise<SubCategory | null>
  create: (input: CreateSubCategory) => Promise<SubCategory>
  countReferences: (subCategoryId: string) => Promise<BlockingReferences>
  delete: (subCategoryId: string) => Promise<void>
}

// Sub-categories are categories with a non-null parent_id.
// We join to the parent to get parentName and kind.
const SUB_SELECT = sql`
  SELECT sc.id, sc.name, sc.parent_id, p.name AS parent_name, p.kind
  FROM categories sc
  JOIN categories p ON p.id = sc.parent_id
  WHERE sc.parent_id IS NOT NULL
`

export const subCategoriesRepo = (db: Db): SubCategoriesRepo => ({
  list: async () => {
    const rows = await db.all<Record<string, unknown>>(sql`
      ${SUB_SELECT}
      ORDER BY p.name, sc.name
    `)
    return rows.map(categoryAdapters.dbToSubCategory)
  },

  listByParent: async (parentId) => {
    const rows = await db.all<Record<string, unknown>>(sql`
      ${SUB_SELECT}
      AND sc.parent_id = ${parentId}
      ORDER BY sc.name
    `)
    return rows.map(categoryAdapters.dbToSubCategory)
  },

  findByName: async (name) => {
    const rows = await db.all<Record<string, unknown>>(sql`
      ${SUB_SELECT}
      AND sc.name = ${name}
      LIMIT 1
    `)
    return rows[0] ? categoryAdapters.dbToSubCategory(rows[0]) : null
  },

  create: async ({ id, name, parentId }) => {
    // kind is inherited from the parent — resolved before the insert so the row is
    // correct from the first write (no placeholder + update, no transient bad state).
    const [parent] = await db.select().from(categories).where(eq(categories.id, parentId))
    const parentKind = expectPresent(parent, 'categories: parent not found for sub-category').kind
    await db.insert(categories).values({ id, name, parentId, kind: parentKind })

    const [row] = await db.all<Record<string, unknown>>(sql`
      SELECT sc.id, sc.name, sc.parent_id, p.name AS parent_name, p.kind
      FROM categories sc JOIN categories p ON p.id = sc.parent_id
      WHERE sc.id = ${id}
    `)
    return categoryAdapters.dbToSubCategory(expectPresent(row, 'categories: sub-category not found after insert'))
  },

  countReferences: async (subCategoryId) => {
    const [txRow] = await db
      .select({ count: sql<number>`count(*)` })
      .from(transactions)
      .where(or(eq(transactions.categoryId, subCategoryId), eq(transactions.subcategoryId, subCategoryId)))
    const [recRow] = await db
      .select({ count: sql<number>`count(*)` })
      .from(recurringRules)
      .where(eq(recurringRules.categoryId, subCategoryId))
    const [subRow] = await db
      .select({ count: sql<number>`count(*)` })
      .from(categories)
      .where(eq(categories.parentId, subCategoryId))
    return {
      transactions: txRow?.count ?? 0,
      recurring: recRow?.count ?? 0,
      subCategories: subRow?.count ?? 0,
    }
  },

  delete: async (subCategoryId) => {
    await db.transaction(async (tx) => {
      await tx.delete(merchantCategory).where(eq(merchantCategory.categoryId, subCategoryId))
      await tx.delete(categories).where(eq(categories.id, subCategoryId))
    })
  },
})
