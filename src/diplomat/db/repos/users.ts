import { eq } from 'drizzle-orm';
import * as userAdapters from '../../../adapters/users.js';
import type { UserEntity } from '../../../models/auth/owner.js';
import type { Db } from '../driver.js';
import { users } from '../schema.js';
import { versionedTableApplier } from '../effects.js';

export type UsersRepo = {
  findById: (id: string) => Promise<UserEntity | null>;
  /** `username` must already be normalized (`logic/auth.ts`'s `normalizeUsername`). */
  findByUsername: (username: string) => Promise<UserEntity | null>;
};

export const usersRepo = (db: Db): UsersRepo => ({
  findById: async (id) => {
    const [row] = await db.select().from(users).where(eq(users.id, id)).limit(1);
    return row ? userAdapters.dbToModel(row) : null;
  },

  findByUsername: async (username) => {
    const [row] = await db.select().from(users).where(eq(users.username, username)).limit(1);
    return row ? userAdapters.dbToModel(row) : null;
  },
});

export const userApplier = versionedTableApplier(users);
