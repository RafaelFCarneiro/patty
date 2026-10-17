import { and, desc, eq, isNull, lte } from 'drizzle-orm';
import * as inviteAdapters from '../../../adapters/invites.js';
import type { InviteEntity } from '../../../models/auth/users.js';
import type { Db } from '../driver.js';
import { invites } from '../schema.js';
import { isUniqueConstraintViolation } from '../sqliteErrors.js';
import { VersionConflict, versionedTableApplier, type EntityApplier } from '../effects.js';

export type InvitesRepo = {
  findByHash: (codeHash: string) => Promise<InviteEntity | null>;
  /** Every invite not yet claimed, live or expired — the ones a new invite for the same user replaces. */
  listUnclaimed: () => Promise<InviteEntity[]>;
  listUnclaimedByUser: (userId: string) => Promise<InviteEntity[]>;
  /** Unclaimed invites whose window has passed (`expiresAt` is ISO, so it sorts chronologically). */
  listExpiredUnclaimed: (nowIso: string) => Promise<InviteEntity[]>;
};

export const invitesRepo = (db: Db): InvitesRepo => ({
  findByHash: async (codeHash) => {
    const [row] = await db.select().from(invites).where(eq(invites.codeHash, codeHash)).limit(1);
    return row ? inviteAdapters.dbToModel(row) : null;
  },

  listUnclaimed: async () => {
    const rows = await db.select().from(invites).where(isNull(invites.usedAt)).orderBy(desc(invites.createdAt));
    return rows.map(inviteAdapters.dbToModel);
  },

  listExpiredUnclaimed: async (nowIso) => {
    const rows = await db
      .select()
      .from(invites)
      .where(and(isNull(invites.usedAt), lte(invites.expiresAt, nowIso)));
    return rows.map(inviteAdapters.dbToModel);
  },

  listUnclaimedByUser: async (userId) => {
    const rows = await db.select().from(invites).where(eq(invites.userId, userId));
    return rows.filter((row) => row.usedAt === null).map(inviteAdapters.dbToModel);
  },
});

const versionedInviteApplier = versionedTableApplier(invites);

/** `invites_one_open_per_user` is unique among UNCLAIMED invites: two admins reissuing for the same user at once both
 *  insert one. The loser's unique violation is rethrown as `VersionConflict`, so the engine rolls back and re-runs the
 *  flow, which then sees (and replaces) the winner's invite. */
export const inviteApplier: EntityApplier = {
  ...versionedInviteApplier,
  insert: async (tx, model, idempotencyKey) => {
    try {
      return await versionedInviteApplier.insert(tx, model, idempotencyKey);
    } catch (cause) {
      if (isUniqueConstraintViolation(cause)) throw new VersionConflict();
      throw cause;
    }
  },
};
