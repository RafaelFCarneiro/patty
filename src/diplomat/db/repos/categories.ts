import { eq, isNull, sql } from 'drizzle-orm';
import * as categoryAdapters from '../../../adapters/categories.js';
import type { Category, CategoryVersion } from '../../../models/category.js';
import type { Db } from '../driver.js';
import { categories, recurringRules, transactions } from '../schema.js';
import { ownedTableApplier, type EntityApplier } from '../effects.js';
import { ownedWhere, visibleWhere } from '../queries/scope.js';

export type ListCategoriesOptions = {
  orderBy?: 'name';
};

export type BlockingReferences = { transactions: number; recurring: number; subCategories: number };

export type CategoriesRepo = {
  list: (options?: ListCategoriesOptions) => Promise<Category[]>;
  countReferences: (categoryId: string) => Promise<BlockingReferences>;
  /** Version-carrying read — for `deleteCategory`/`deleteSubCategory`, which need it to
   *  build a version-guarded `Persistable`. Shared by both, since a sub-category is a row in this
   *  same table. */
  findRawById: (categoryId: string) => Promise<CategoryVersion | null>;
};

export const categoriesRepo = (db: Db, userId: string): CategoriesRepo => ({
  /** Top-level categories only — sub-categories belong to subCategoriesRepo. */
  list: async (options) => {
    const query = db
      .select()
      .from(categories)
      .where(visibleWhere(categories.userId, userId, isNull(categories.parentId)));
    const rows = options?.orderBy === 'name' ? await query.orderBy(categories.name) : await query;
    return rows.map(categoryAdapters.dbToModel);
  },

  countReferences: async (categoryId) => {
    const [byCat] = await db
      .select({ count: sql<number>`count(*)` })
      .from(transactions)
      .where(ownedWhere(transactions.userId, userId, eq(transactions.categoryId, categoryId)));
    const [bySub] = await db
      .select({ count: sql<number>`count(*)` })
      .from(transactions)
      .where(ownedWhere(transactions.userId, userId, eq(transactions.subcategoryId, categoryId)));
    const [recRow] = await db
      .select({ count: sql<number>`count(*)` })
      .from(recurringRules)
      .where(ownedWhere(recurringRules.userId, userId, eq(recurringRules.categoryId, categoryId)));
    const [subRow] = await db
      .select({ count: sql<number>`count(*)` })
      .from(categories)
      .where(visibleWhere(categories.userId, userId, eq(categories.parentId, categoryId)));
    return {
      transactions: (byCat?.count ?? 0) + (bySub?.count ?? 0),
      recurring: recRow?.count ?? 0,
      subCategories: subRow?.count ?? 0,
    };
  },

  findRawById: async (categoryId) => {
    const [row] = await db
      .select({ id: categories.id, version: categories.version, userId: categories.userId })
      .from(categories)
      .where(visibleWhere(categories.userId, userId, eq(categories.id, categoryId)))
      .limit(1);
    return row ? { id: row.id, version: row.version, shared: row.userId === null } : null;
  },
});

/** Shared by both a top-level category and a sub-category (same table). Deleting a category also
 *  clears its `merchant_category` learning rows, but that's a schema-declared `ON DELETE CASCADE`
 *  on `merchant_category.category_id` (`schema.ts`), not applier code — this stays plain. */
export const categoryApplier = (userId: string): EntityApplier => ownedTableApplier(categories, userId);
