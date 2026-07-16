import { eq, sql } from 'drizzle-orm';
import * as categoryAdapters from '../../../adapters/categories.js';
import type { SubCategory } from '../../../models/category.js';
import type { BlockingReferences } from './categories.js';
import type { Db } from '../driver.js';
import { categories, recurringRules, transactions } from '../schema.js';

export type SubCategoriesRepo = {
  list: () => Promise<SubCategory[]>;
  listByParent: (parentId: string) => Promise<SubCategory[]>;
  findByName: (name: string) => Promise<SubCategory | null>;
  countReferences: (subCategoryId: string) => Promise<BlockingReferences>;
};

// Sub-categories are categories with a non-null parent_id.
// We join to the parent to get parentName and kind.
const SUB_SELECT = sql`
  SELECT sc.id, sc.name, sc.parent_id, p.name AS parent_name, p.kind
  FROM categories sc
  JOIN categories p ON p.id = sc.parent_id
  WHERE sc.parent_id IS NOT NULL
`;

export const subCategoriesRepo = (db: Db): SubCategoriesRepo => ({
  list: async () => {
    const rows = await db.all<Record<string, unknown>>(sql`
      ${SUB_SELECT}
      ORDER BY p.name, sc.name
    `);
    return rows.map(categoryAdapters.dbToSubCategory);
  },

  listByParent: async (parentId) => {
    const rows = await db.all<Record<string, unknown>>(sql`
      ${SUB_SELECT}
      AND sc.parent_id = ${parentId}
      ORDER BY sc.name
    `);
    return rows.map(categoryAdapters.dbToSubCategory);
  },

  findByName: async (name) => {
    const rows = await db.all<Record<string, unknown>>(sql`
      ${SUB_SELECT}
      AND sc.name = ${name}
      LIMIT 1
    `);
    return rows[0] ? categoryAdapters.dbToSubCategory(rows[0]) : null;
  },

  countReferences: async (subCategoryId) => {
    const [byCat] = await db
      .select({ count: sql<number>`count(*)` })
      .from(transactions)
      .where(eq(transactions.categoryId, subCategoryId));
    const [bySub] = await db
      .select({ count: sql<number>`count(*)` })
      .from(transactions)
      .where(eq(transactions.subcategoryId, subCategoryId));
    const [recRow] = await db
      .select({ count: sql<number>`count(*)` })
      .from(recurringRules)
      .where(eq(recurringRules.categoryId, subCategoryId));
    const [subRow] = await db
      .select({ count: sql<number>`count(*)` })
      .from(categories)
      .where(eq(categories.parentId, subCategoryId));
    return {
      transactions: (byCat?.count ?? 0) + (bySub?.count ?? 0),
      recurring: recRow?.count ?? 0,
      subCategories: subRow?.count ?? 0,
    };
  },

});
