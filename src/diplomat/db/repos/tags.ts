import { eq } from 'drizzle-orm';
import * as tagAdapters from '../../../adapters/tags.js';
import type { Tag, TagEntity } from '../../../models/tag.js';
import type { Db } from '../driver.js';
import { tags } from '../schema.js';
import { ownedTableApplier, uniqueViolationAsConflict, type EntityApplier } from '../effects.js';
import { ownedWhere, type RepoScope } from '../queries/scope.js';

export type TagsRepo = {
  list: () => Promise<Tag[]>;
  findByName: (name: string) => Promise<Tag | null>;
  /** Version-carrying read — for `deleteTag`, which needs it to build a `Persistable`. */
  findById: (id: string) => Promise<TagEntity | null>;
};

const list = async ({ db, userId }: RepoScope): ReturnType<TagsRepo['list']> => {
  const rows = await db.select().from(tags).where(ownedWhere(tags.userId, userId)).orderBy(tags.name);
  return rows.map(tagAdapters.dbToModel);
};

const findByName = async ({ db, userId }: RepoScope, name: string): ReturnType<TagsRepo['findByName']> => {
  const [row] = await db
    .select()
    .from(tags)
    .where(ownedWhere(tags.userId, userId, eq(tags.name, name)))
    .limit(1);
  return row ? tagAdapters.dbToModel(row) : null;
};

const findById = async ({ db, userId }: RepoScope, id: string): ReturnType<TagsRepo['findById']> => {
  const [row] = await db
    .select()
    .from(tags)
    .where(ownedWhere(tags.userId, userId, eq(tags.id, id)))
    .limit(1);
  return row ? tagAdapters.dbToEntity(row) : null;
};

export const tagsRepo = (db: Db, userId: string): TagsRepo => {
  const scope: RepoScope = { db, userId };
  return {
    list: () => list(scope),
    findByName: (name) => findByName(scope, name),
    findById: (id) => findById(scope, id),
  };
};

// UNIQUE(user_id, name): a concurrent create of one tag name.
export const tagApplier = (userId: string): EntityApplier => uniqueViolationAsConflict(ownedTableApplier(tags, userId));
