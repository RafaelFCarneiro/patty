import { eq } from 'drizzle-orm';
import * as tagAdapters from '../../../adapters/tags.js';
import type { Tag, TagEntity } from '../../../models/tag.js';
import type { Db } from '../driver.js';
import { tags } from '../schema.js';
import { isUniqueConstraintViolation } from '../sqliteErrors.js';
import { VersionConflict, versionedTableApplier, type EntityApplier } from '../unitOfWork.js';

export type TagsRepo = {
  list: () => Promise<Tag[]>;
  findByName: (name: string) => Promise<Tag | null>;
  /** Version-carrying read (ADR-021) — for `deleteTag`, which needs it to build a `Persistable`. */
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

/** `tags.name` carries its own `UNIQUE` constraint (the domain's own pre-check, `createTag`'s
 *  `assertTagNameAvailable`, only guards the common case) — a concurrent create of the same name
 *  can raise a genuine unique-constraint error that `versionedTableApplier`'s id-scoped
 *  `onConflictDoNothing` doesn't swallow, the table's only other unique constraint. Mirrors
 *  `diplomat/db/repos/bills.ts`'s `billApplier`: recognize that one violation and rethrow it as
 *  `VersionConflict`, rolling the batch back and retrying the flow (rule 4) — on retry,
 *  `assertTagNameAvailable` sees the now-committed row and returns the proper `duplicate_name`
 *  error, instead of a raw 500. `update`/`delete` are plain `versionedTableApplier`. */
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
