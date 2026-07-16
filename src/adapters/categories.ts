import {
  CATEGORY_ENTITY_TAG,
  CategorySchema,
  LocalizedNamesSchema,
  SubCategorySchema,
  type Category,
  type CategoryWriteModel,
  type CreateCategory,
  type SubCategory,
} from '../models/category.js';
import * as persistence from '../logic/persistence.js';
import { SubCategoryRowSchema, type CategoryRow } from '../wire/db/categories.js';
import type * as wireIn from '../wire/in/categories.js';

// Input is the schema-derived Drizzle row; CategorySchema.parse enforces domain constraints.
export const dbToModel = (row: CategoryRow): Category =>
  CategorySchema.parse({
    id: row.id,
    name: row.name,
    kind: row.kind,
    names: row.names !== null ? LocalizedNamesSchema.parse(JSON.parse(row.names)) : null,
  });

export const dbToSubCategory = (record: Record<string, unknown>): SubCategory => {
  const row = SubCategoryRowSchema.parse(record);
  return SubCategorySchema.parse({
    id: row.id,
    name: row.name,
    parentId: row.parent_id,
    parentName: row.parent_name,
    kind: row.kind,
  });
};

export const wireInToModel = (input: wireIn.CreateCategory): CreateCategory => input;

/** Entity → row for the versioned unit of work — shared by a top-level category and a sub-category,
 *  both rows in the `categories` table. */
export const modelToDb = (entity: CategoryWriteModel & { version: number }): CategoryRow => ({
  id: entity.id,
  name: entity.name,
  kind: entity.kind,
  parentId: entity.parentId ?? null,
  names: entity.names ? JSON.stringify(entity.names) : null,
  version: entity.version,
});

export const { persistableToDb, outcomeToDb } = persistence.entityDbAdapter(CATEGORY_ENTITY_TAG, modelToDb);
