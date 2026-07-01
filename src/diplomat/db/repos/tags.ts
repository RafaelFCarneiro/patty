import { eq } from 'drizzle-orm';
import * as tagAdapters from '../../../adapters/tags.js';
import type { Tag } from '../../../models/tag.js';
import type { Db } from '../driver.js';
import { tags } from '../schema.js';

export type TagsRepo = {
  list: () => Promise<Tag[]>;
  findByName: (name: string) => Promise<Tag | null>;
  /** Returns `null` when a tag with the same name already exists. */
  create: (tag: Tag) => Promise<Tag | null>;
  delete: (id: string) => Promise<boolean>;
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

  create: async (tag) => {
    const [row] = await db
      .insert(tags)
      .values({ id: tag.id, name: tag.name })
      .onConflictDoNothing({ target: tags.name })
      .returning();
    return row ? tagAdapters.dbToModel(row) : null;
  },

  delete: async (id) => {
    const result = await db.delete(tags).where(eq(tags.id, id));
    return (result.rowsAffected ?? 0) > 0;
  },
});
