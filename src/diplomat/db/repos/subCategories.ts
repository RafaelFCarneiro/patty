import { eq, sql } from 'drizzle-orm'
import * as categoryAdapters from '../../../adapters/categories.js'
import { expectPresent } from '../../../common/present.js'
import type { SubCategory, CreateSubCategory } from '../../../models/category.js'
import type { Db } from '../driver.js'
import { categories } from '../schema.js'

export type SubCategoriesRepo = {
  list: () => Promise<SubCategory[]>
  listByParent: (parentId: string) => Promise<SubCategory[]>
  findByName: (name: string) => Promise<SubCategory | null>
  create: (input: CreateSubCategory) => Promise<SubCategory>
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
})
