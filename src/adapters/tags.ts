import { TAG_ENTITY_TAG, TagEntitySchema, TagSchema, type Tag, type TagEntity } from '../models/tag.js';
import { INITIAL_VERSION, PersistOp, type FlowOutcome, type Persistable } from '../models/persistable.js';
import type { TagRow } from '../wire/db/tags.js';

export const dbToModel = (row: TagRow): Tag => TagSchema.parse({ id: row.id, name: row.name });

/** Read variant carrying `version` — for `deleteTag`, which needs it to build a version-guarded
 *  `Persistable`. */
export const dbToEntity = (row: TagRow): TagEntity =>
  TagEntitySchema.parse({ id: row.id, name: row.name, version: row.version });

/** Adapts one tag `Persistable`'s `model` from domain shape to db-row shape, called explicitly
 *  before the batch reaches `withUnitOfWork`. No-ops on a `Persistable` tagged for a different
 *  entity. */
export const persistableToDb = (p: Persistable): Persistable => {
  if (p.entity !== TAG_ENTITY_TAG) return p;
  switch (p.op) {
    case PersistOp.enum.insert:
      return { ...p, model: { ...(p.model as Tag), version: INITIAL_VERSION } };
    case PersistOp.enum.update:
      return p;
    case PersistOp.enum.delete:
      return p;
    default: {
      const _exhaustive: never = p;
      throw new Error(`tagAdapters.persistableToDb: unhandled persistable op ${JSON.stringify(_exhaustive)}`);
    }
  }
};

/** Maps every `Persistable` in a flow's outcome through `persistableToDb` before `unitOfWork`. */
export const outcomeToDb = <T>(outcome: FlowOutcome<T>): FlowOutcome<T> => ({
  ...outcome,
  persist: outcome.persist.map(persistableToDb),
});
