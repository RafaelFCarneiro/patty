import { asc, eq } from 'drizzle-orm';
import * as userAdapters from '../../../adapters/users.js';
import type { UserEntity } from '../../../models/auth/owner.js';
import type { Db } from '../driver.js';
import { users } from '../schema.js';
import { isUniqueConstraintViolation } from '../sqlite-errors.js';
import { VersionConflict, versionedTableApplier, type EntityApplier } from '../effects.js';

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

const versionedUserApplier = versionedTableApplier(users);

/** `users.username` is unique: two admins inviting the same name at once both insert it. The loser's unique
 *  violation is
 *  rethrown as `VersionConflict`, so the engine re-runs the flow, which then reports `username_taken`. */
export const userApplier: EntityApplier = {
  ...versionedUserApplier,
  insert: async (tx, model, idempotencyKey) => {
    try {
      return await versionedUserApplier.insert(tx, model, idempotencyKey);
    } catch (cause) {
      if (isUniqueConstraintViolation(cause)) throw new VersionConflict();
      throw cause;
    }
  },

  // A claim sets the owner's username with an `update`, which can collide on the same unique column.
  update: async (tx, model) => {
    try {
      return await versionedUserApplier.update(tx, model);
    } catch (cause) {
      if (isUniqueConstraintViolation(cause)) throw new VersionConflict();
      throw cause;
    }
  },
};
