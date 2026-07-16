import { eq, isNull, sql } from 'drizzle-orm';
import * as categoryAdapters from '../../../adapters/categories.js';
import { expectPresent, rowNotFoundAfterWrite } from '../present.js';
import type { Category, CategoryVersion } from '../../../models/category.js';
import type { Db } from '../driver.js';
import { categories, merchantCategory, recurringRules, transactions } from '../schema.js';
import { versionedTableApplier, type EntityApplier } from '../unitOfWork.js';

export type ListCategoriesOptions = {
  orderBy?: 'name';
};

export type BlockingReferences = { transactions: number; recurring: number; subCategories: number };

export type CategoriesRepo = {
  list: (options?: ListCategoriesOptions) => Promise<Category[]>;
  create: (category: Category) => Promise<Category>;
  countReferences: (categoryId: string) => Promise<BlockingReferences>;
  delete: (categoryId: string) => Promise<void>;
  /** Version-carrying read (ADR-021) — for `deleteCategory`/`deleteSubCategory`, which need it to
   *  build a version-guarded `Persistable`. Shared by both, since a sub-category is a row in this
   *  same table. */
  findRawById: (categoryId: string) => Promise<CategoryVersion | null>;
};

export const categoriesRepo = (db: Db): CategoriesRepo => ({
  /** Top-level categories only — sub-categories (parent_id set) belong to subCategoriesRepo. */
  list: async (options) => {
    const query = db.select().from(categories).where(isNull(categories.parentId));
    const rows = options?.orderBy === 'name' ? await query.orderBy(categories.name) : await query;
    return rows.map(categoryAdapters.dbToModel);
  },

  create: async (category) => {
    const [row] = await db
      .insert(categories)
      .values({
        id: category.id,
        name: category.name,
        kind: category.kind,
        names: category.names ? JSON.stringify(category.names) : null,
      })
      .returning();
    return categoryAdapters.dbToModel(expectPresent(row, rowNotFoundAfterWrite('categories', 'insert')));
  },

  countReferences: async (categoryId) => {
    const [byCat] = await db
      .select({ count: sql<number>`count(*)` })
      .from(transactions)
      .where(eq(transactions.categoryId, categoryId));
    const [bySub] = await db
      .select({ count: sql<number>`count(*)` })
      .from(transactions)
      .where(eq(transactions.subcategoryId, categoryId));
    const [recRow] = await db
      .select({ count: sql<number>`count(*)` })
      .from(recurringRules)
      .where(eq(recurringRules.categoryId, categoryId));
    const [subRow] = await db
      .select({ count: sql<number>`count(*)` })
      .from(categories)
      .where(eq(categories.parentId, categoryId));
    return {
      transactions: (byCat?.count ?? 0) + (bySub?.count ?? 0),
      recurring: recRow?.count ?? 0,
      subCategories: subRow?.count ?? 0,
    };
  },

  delete: async (categoryId) => {
    await db.transaction(async (tx) => {
      await tx.delete(merchantCategory).where(eq(merchantCategory.categoryId, categoryId));
      await tx.delete(categories).where(eq(categories.id, categoryId));
    });
  },

  findRawById: async (categoryId) => {
    const [row] = await db
      .select({ id: categories.id, version: categories.version })
      .from(categories)
      .where(eq(categories.id, categoryId))
      .limit(1);
    return row ?? null;
  },
});

const versionedCategoryApplier = versionedTableApplier(categories);

/**
 * The category entity's `EntityApplier` (ADR-021) — shared by both a top-level category and a
 * sub-category (same table). `merchant_category.category_id` references `categories.id` with no
 * `ON DELETE` action (libsql enforces foreign keys), so a plain versioned delete of the category
 * row would fail while any learned merchant association still points at it — the domain's own
 * referential-integrity guard (`isCategoryUnreferenced`) only checks transactions/recurring/
 * sub-categories, deliberately leaving merchant learning out of what blocks a delete (a category
 * delete is meant to also clear its learned classifications, re-learnable later). Mirrors the
 * pre-ADR-021 repo `delete` above: purge the dependent `merchant_category` rows first, in the same
 * transaction, then the version-guarded row delete — genuine extra mechanics beyond the plain
 * `id`/`version` convention, so this is a hand-written applier rather than
 * `versionedTableApplier(categories)` directly (mirrors `diplomat/db/repos/bills.ts`'s
 * `billApplier`). `insert`/`update` have no such mechanics and stay plain.
 */
export const categoryApplier: EntityApplier = {
  ...versionedCategoryApplier,
  delete: async (tx, id, version) => {
    await tx.delete(merchantCategory).where(eq(merchantCategory.categoryId, id));
    return versionedCategoryApplier.delete(tx, id, version);
  },
};
