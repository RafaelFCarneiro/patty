import { eq, sql } from 'drizzle-orm';
import * as categoryAdapters from '../../../adapters/categories.js';
import type { SubCategory } from '../../../models/category.js';
import type { BlockingReferences } from './categories.js';
import type { Db } from '../driver.js';
import { categories, recurringRules, transactions } from '../schema.js';
import { ownedWhere, visibleTo, visibleWhere, type RepoScope } from '../queries/scope.js';

export type SubCategoriesRepo = {
  list: () => Promise<SubCategory[]>;
  listByParent: (parentId: string) => Promise<SubCategory[]>;
  findByName: (name: string) => Promise<SubCategory | null>;
  countReferences: (subCategoryId: string) => Promise<BlockingReferences>;
};

// Sub-categories are categories with a non-null parent_id.
// We join to the parent to get parentName and kind; both must be visible to the user.
const SUB_SELECT = (userId: string) => sql`
  SELECT sc.id, sc.name, sc.parent_id, p.name AS parent_name, p.kind
  FROM categories sc
  JOIN categories p ON p.id = sc.parent_id
  WHERE sc.parent_id IS NOT NULL
    AND ${visibleTo(userId, 'sc')}
    AND ${visibleTo(userId, 'p')}
`;

const list = async ({ db, userId }: RepoScope): ReturnType<SubCategoriesRepo['list']> => {
  const rows = await db.all<Record<string, unknown>>(sql`
      ${SUB_SELECT(userId)}
      ORDER BY p.name, sc.name
    `);
  return rows.map(categoryAdapters.dbToSubCategory);
};

const listByParent = async (
  { db, userId }: RepoScope,
  parentId: string,
): ReturnType<SubCategoriesRepo['listByParent']> => {
  const rows = await db.all<Record<string, unknown>>(sql`
      ${SUB_SELECT(userId)}
      AND sc.parent_id = ${parentId}
      ORDER BY sc.name
    `);
  return rows.map(categoryAdapters.dbToSubCategory);
};

const findByName = async ({ db, userId }: RepoScope, name: string): ReturnType<SubCategoriesRepo['findByName']> => {
  const rows = await db.all<Record<string, unknown>>(sql`
      ${SUB_SELECT(userId)}
      AND sc.name = ${name}
      LIMIT 1
    `);
  return rows[0] ? categoryAdapters.dbToSubCategory(rows[0]) : null;
};

const countReferences = async (
  { db, userId }: RepoScope,
  subCategoryId: string,
): ReturnType<SubCategoriesRepo['countReferences']> => {
  const [byCat] = await db
    .select({ count: sql<number>`count(*)` })
    .from(transactions)
    .where(ownedWhere(transactions.userId, userId, eq(transactions.categoryId, subCategoryId)));
  const [bySub] = await db
    .select({ count: sql<number>`count(*)` })
    .from(transactions)
    .where(ownedWhere(transactions.userId, userId, eq(transactions.subcategoryId, subCategoryId)));
  const [recRow] = await db
    .select({ count: sql<number>`count(*)` })
    .from(recurringRules)
    .where(ownedWhere(recurringRules.userId, userId, eq(recurringRules.categoryId, subCategoryId)));
  const [subRow] = await db
    .select({ count: sql<number>`count(*)` })
    .from(categories)
    .where(visibleWhere(categories.userId, userId, eq(categories.parentId, subCategoryId)));
  return {
    transactions: (byCat?.count ?? 0) + (bySub?.count ?? 0),
    recurring: recRow?.count ?? 0,
    subCategories: subRow?.count ?? 0,
  };
};

export const subCategoriesRepo = (db: Db, userId: string): SubCategoriesRepo => {
  const scope: RepoScope = { db, userId };
  return {
    list: () => list(scope),
    listByParent: (parentId) => listByParent(scope, parentId),
    findByName: (name) => findByName(scope, name),
    countReferences: (subCategoryId) => countReferences(scope, subCategoryId),
  };
};
