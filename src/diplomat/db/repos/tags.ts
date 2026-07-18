import { eq } from 'drizzle-orm';
import * as tagAdapters from '../../../adapters/tags.js';
import type { Tag, TagEntity } from '../../../models/tag.js';
import type { Db } from '../driver.js';
import { tags } from '../schema.js';
import { isUniqueConstraintViolation } from '../sqliteErrors.js';
import { VersionConflict, versionedTableApplier, type EntityApplier } from '../effects.js';

export type TagsRepo = {
  list: () => Promise<Tag[]>;
  findByName: (name: string) => Promise<Tag | null>;
  /** Version-carrying read — for `deleteTag`, which needs it to build a `Persistable`. */
  findById: (id: string) => Promise<TagEntity | null>;
};

export const tagsRepo = (db: Db): TagsRepo => ({
  list: async () => {
    const rows = await db.select().from(tags).orderBy(tags.name);
    return rows.map(tagAdapters.dbToModel);
  },

  findByName: async (name) => {
    const [row] = await db.select().from(tags).where(eq(tags.name, name)).limit(1);
    return row ? tagAdapters.dbToModel(row) : null;
  },

  findById: async (id) => {
    const [row] = await db.select().from(tags).where(eq(tags.id, id)).limit(1);
    return row ? tagAdapters.dbToEntity(row) : null;
  },
});

const versionedTagApplier = versionedTableApplier(tags);

/** `tags.name` has its own `UNIQUE` constraint beyond `createTag`'s pre-check
 *  (`assertTagNameAvailable`, which only guards the common case) — a concurrent same-name insert
 *  can raise a real unique-constraint error `versionedTableApplier`'s id-scoped
 *  `onConflictDoNothing` doesn't swallow. Recognized and rethrown as `VersionConflict`, rolling
 *  back and retrying — the retry's own `assertTagNameAvailable` then sees the committed row and
 *  returns `duplicate_name` instead of a raw 500. `update`/`delete` stay plain. */
export const tagApplier: EntityApplier = {
  ...versionedTagApplier,
  insert: async (tx, model) => {
    try {
      return await versionedTagApplier.insert(tx, model);
    } catch (cause) {
      if (isUniqueConstraintViolation(cause)) throw new VersionConflict();
      throw cause;
    }
  },
};
