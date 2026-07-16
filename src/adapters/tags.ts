import { TAG_ENTITY_TAG, TagEntitySchema, TagSchema, type Tag, type TagEntity } from '../models/tag.js';
import * as persistence from '../logic/persistence.js';
import type { TagRow } from '../wire/db/tags.js';

export const dbToModel = (row: TagRow): Tag => TagSchema.parse({ id: row.id, name: row.name });

/** Read variant carrying `version` — for `deleteTag`, which needs it to build a version-guarded
 *  `Persistable`. */
export const dbToEntity = (row: TagRow): TagEntity =>
  TagEntitySchema.parse({ id: row.id, name: row.name, version: row.version });

/** Entity → row for the versioned unit of work — a `Tag` is already row-shaped once versioned. */
export const modelToDb = (entity: TagEntity): TagRow => entity;

export const { persistableToDb, outcomeToDb } = persistence.entityDbAdapter(TAG_ENTITY_TAG, modelToDb);
