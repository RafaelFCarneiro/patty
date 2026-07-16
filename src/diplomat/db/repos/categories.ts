import { eq, isNull, sql } from 'drizzle-orm';
import * as categoryAdapters from '../../../adapters/categories.js';
import { expectPresent, rowNotFoundAfterWrite } from '../present.js';
import type { Category, CategoryVersion } from '../../../models/category.js';
import type { Db } from '../driver.js';
import { categories, recurringRules, transactions } from '../schema.js';
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

  // merchant_category rows for this category cascade away on their own (schema-declared
  // ON DELETE CASCADE on merchant_category.category_id) — no separate delete needed here.
  delete: async (categoryId) => {
    await db.delete(categories).where(eq(categories.id, categoryId));
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

/**
 * The category entity's `EntityApplier` (ADR-021) — shared by both a top-level category and a
 * sub-category (same table). Plain `versionedTableApplier(categories)` — deleting a category row
 * has no mechanics beyond the ordinary `id`/`version` convention. It once did: an earlier version
 * of this applier purged dependent `merchant_category` rows itself before the row delete, imitating
 * an `ON DELETE CASCADE` by hand — the repo deciding a referential-integrity mechanic that belongs
 * to the schema, the same layering slip `diplomat/db/repos/creditCards.ts`'s `creditCardApplier`
 * had (see its own doc comment). Unlike that case, though, this cleanup is *pure mechanics* with no
 * decision in it at all — no reads, no branching, always the same unconditional cascade whenever a
 * category disappears (the domain's own referential-integrity guard, `isCategoryUnreferenced`,
 * already deliberately leaves merchant learning out of what *blocks* a delete — a category delete
 * is meant to also clear its learned classifications, re-learnable later — so there was never a
 * decision left for the domain to make here). That makes it structurally identical to
 * `transaction_tags.transaction_id`'s `ON DELETE CASCADE` (`schema.ts`) — an association row with
 * no independent meaning once its owner is gone — so it now lives there too:
 * `merchant_category.category_id` references `categories.id` with `{ onDelete: 'cascade' }`
 * (migration `drizzle/0010_category_merchant_association_cascade.sql`). The applier writes only the
 * row it's handed, same as every other plain entity.
 */
export const categoryApplier: EntityApplier = versionedTableApplier(categories);
