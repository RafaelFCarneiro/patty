import { asc, eq } from 'drizzle-orm';
import * as userAdapters from '../../../adapters/users.js';
import type { UserEntity } from '../../../models/auth/owner.js';
import type { Db } from '../driver.js';
import { users } from '../schema.js';
import { uniqueViolationAsConflict, versionedTableApplier, type EntityApplier } from '../effects.js';

export type UsersRepo = {
  findById: (id: string) => Promise<UserEntity | null>;
  /** `username` must already be normalized (`models/auth/password.ts`'s `normalizeUsername`). */
  findByUsername: (username: string) => Promise<UserEntity | null>;
  /** Every user, oldest first. */
  listAll: () => Promise<UserEntity[]>;
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

  listAll: async () => {
    const rows = await db.select().from(users).orderBy(asc(users.createdAt), asc(users.id));
    return rows.map(userAdapters.dbToModel);
  },
});

// UNIQUE(username): a concurrent invite of one name, or the owner claim's update onto a taken one.
export const userApplier: EntityApplier = uniqueViolationAsConflict(versionedTableApplier(users));
