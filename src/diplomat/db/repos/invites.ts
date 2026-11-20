import { and, desc, eq, isNull, lte } from 'drizzle-orm';
import * as inviteAdapters from '../../../adapters/invites.js';
import type { InviteEntity } from '../../../models/auth/users.js';
import type { Db } from '../driver.js';
import { invites } from '../schema.js';
import { uniqueViolationAsConflict, versionedTableApplier, type EntityApplier } from '../effects.js';

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

// UNIQUE(user_id) among unclaimed invites: a concurrent reissue for one user.
export const inviteApplier: EntityApplier = uniqueViolationAsConflict(versionedTableApplier(invites));
