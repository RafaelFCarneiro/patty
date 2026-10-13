import { and, desc, eq } from 'drizzle-orm';
import * as accessTokenAdapters from '../../../adapters/accessTokens.js';
import type { AccessTokenEntity } from '../../../models/auth/token.js';
import type { Db } from '../driver.js';
import { accessTokens } from '../schema.js';
import { versionedTableApplier } from '../effects.js';

export type AccessTokensRepo = {
  findByTokenHash: (tokenHash: string) => Promise<AccessTokenEntity | null>;
  /** Scoped to the owning user, so another user's token id reads as absent. */
  findById: (userId: string, id: string) => Promise<AccessTokenEntity | null>;
  /** Newest first. */
  listByUser: (userId: string) => Promise<AccessTokenEntity[]>;
};

export const accessTokensRepo = (db: Db): AccessTokensRepo => ({
  findByTokenHash: async (tokenHash) => {
    const [row] = await db.select().from(accessTokens).where(eq(accessTokens.tokenHash, tokenHash)).limit(1);
    return row ? accessTokenAdapters.dbToModel(row) : null;
  },

  findById: async (userId, id) => {
    const [row] = await db
      .select()
      .from(accessTokens)
      .where(and(eq(accessTokens.id, id), eq(accessTokens.userId, userId)))
      .limit(1);
    return row ? accessTokenAdapters.dbToModel(row) : null;
  },

  listByUser: async (userId) => {
    const rows = await db
      .select()
      .from(accessTokens)
      .where(eq(accessTokens.userId, userId))
      .orderBy(desc(accessTokens.createdAt));
    return rows.map(accessTokenAdapters.dbToModel);
  },
});

export const accessTokenApplier = versionedTableApplier(accessTokens);
