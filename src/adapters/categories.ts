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
import { INITIAL_VERSION, PersistOp, type FlowOutcome, type Persistable } from '../models/persistable.js';
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

/** Entity → row for the versioned unit of work (ADR-021) — shared by a top-level category and a
 *  sub-category, both rows in the `categories` table. */
export const modelToDb = (entity: CategoryWriteModel & { version: number }): CategoryRow => ({
  id: entity.id,
  name: entity.name,
  kind: entity.kind,
  parentId: entity.parentId ?? null,
  names: entity.names ? JSON.stringify(entity.names) : null,
  version: entity.version,
});

/** Adapts one category `Persistable`'s `model` from domain shape to db-row shape (ADR-021),
 *  mirroring `adapters/accounts.ts`'s `persistableToDb` — called explicitly by the MCP/REST
 *  handler before the batch ever reaches `withUnitOfWork`. No-ops on a `Persistable` tagged for a
 *  different entity. Only `insert` ever carries a model here (no category `update` flow yet). */
export const persistableToDb = (p: Persistable): Persistable => {
  if (p.entity !== CATEGORY_ENTITY_TAG) return p;
  switch (p.op) {
    case PersistOp.enum.insert:
      return { ...p, model: modelToDb({ ...(p.model as CategoryWriteModel), version: INITIAL_VERSION }) };
    case PersistOp.enum.update:
      return p;
    case PersistOp.enum.delete:
      return p;
    default: {
      const _exhaustive: never = p;
      throw new Error(`categoryAdapters.persistableToDb: unhandled persistable op ${JSON.stringify(_exhaustive)}`);
    }
  }
};

/** Maps every `Persistable` in a flow's outcome through `persistableToDb` before `unitOfWork`. */
export const outcomeToDb = <T>(outcome: FlowOutcome<T>): FlowOutcome<T> => ({
  ...outcome,
  persist: outcome.persist.map(persistableToDb),
});
