import {
  CategorySchema,
  LocalizedNamesSchema,
  SubCategorySchema,
  type Category,
  type CreateCategory,
  type SubCategory,
} from '../models/category.js';
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
