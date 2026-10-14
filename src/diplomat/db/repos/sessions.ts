import { eq, lte } from 'drizzle-orm';
import * as sessionAdapters from '../../../adapters/sessions.js';
import type { SessionEntity } from '../../../models/auth/session.js';
import type { Db } from '../driver.js';
import { sessions } from '../schema.js';
import { versionedTableApplier } from '../effects.js';

export type SessionsRepo = {
  findByTokenHash: (tokenHash: string) => Promise<SessionEntity | null>;
  /** Rows whose idle expiry has passed — `expiresAt` is an ISO string, which sorts chronologically. */
  listExpired: (nowIso: string) => Promise<SessionEntity[]>;
  listByUser: (userId: string) => Promise<SessionEntity[]>;
};

export const sessionsRepo = (db: Db): SessionsRepo => ({
  findByTokenHash: async (tokenHash) => {
    const [row] = await db.select().from(sessions).where(eq(sessions.tokenHash, tokenHash)).limit(1);
    return row ? sessionAdapters.dbToModel(row) : null;
  },

  listExpired: async (nowIso) => {
    const rows = await db.select().from(sessions).where(lte(sessions.expiresAt, nowIso));
    return rows.map(sessionAdapters.dbToModel);
  },

  listByUser: async (userId) => {
    const rows = await db.select().from(sessions).where(eq(sessions.userId, userId));
    return rows.map(sessionAdapters.dbToModel);
  },
});

export const sessionApplier = versionedTableApplier(sessions);
