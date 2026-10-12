import { and, desc, eq, lte, ne } from 'drizzle-orm';
import * as clientGrantAdapters from '../../../adapters/clientGrants.js';
import { GrantStatus, type ClientGrantEntity } from '../../../models/auth.js';
import type { Db } from '../driver.js';
import { clientGrants } from '../schema.js';
import { versionedTableApplier } from '../effects.js';

export type ClientGrantsRepo = {
  findByDeviceCodeHash: (deviceCodeHash: string) => Promise<ClientGrantEntity | null>;
  findPendingByUserCode: (userCode: string) => Promise<ClientGrantEntity | null>;
  /** The newest sign-in this user actually completed for this client on this profile — the consent form's memory. */
  lastRedeemed: (userId: string, profile: string, clientName: string) => Promise<ClientGrantEntity | null>;
  /** Grants that ran out their window without being redeemed (`expiresAt` is ISO, so it sorts chronologically). */
  listExpired: (nowIso: string) => Promise<ClientGrantEntity[]>;
};

export const clientGrantsRepo = (db: Db): ClientGrantsRepo => ({
  findByDeviceCodeHash: async (deviceCodeHash) => {
    const [row] = await db.select().from(clientGrants).where(eq(clientGrants.deviceCodeHash, deviceCodeHash)).limit(1);
    return row ? clientGrantAdapters.dbToModel(row) : null;
  },

  findPendingByUserCode: async (userCode) => {
    const [row] = await db
      .select()
      .from(clientGrants)
      .where(and(eq(clientGrants.userCode, userCode), eq(clientGrants.status, GrantStatus.enum.pending)))
      .limit(1);
    return row ? clientGrantAdapters.dbToModel(row) : null;
  },

  lastRedeemed: async (userId, profile, clientName) => {
    const [row] = await db
      .select()
      .from(clientGrants)
      .where(
        and(
          eq(clientGrants.userId, userId),
          eq(clientGrants.profile, profile),
          eq(clientGrants.clientName, clientName),
          eq(clientGrants.status, GrantStatus.enum.redeemed),
        ),
      )
      .orderBy(desc(clientGrants.createdAt))
      .limit(1);
    return row ? clientGrantAdapters.dbToModel(row) : null;
  },

  listExpired: async (nowIso) => {
    const rows = await db
      .select()
      .from(clientGrants)
      .where(and(lte(clientGrants.expiresAt, nowIso), ne(clientGrants.status, GrantStatus.enum.redeemed)));
    return rows.map(clientGrantAdapters.dbToModel);
  },
});

export const clientGrantApplier = versionedTableApplier(clientGrants);
