import { and, desc, eq, lte, ne } from 'drizzle-orm';
import * as clientGrantAdapters from '../../../adapters/clientGrants.js';
import { type ClientGrantEntity, GrantStatus } from '../../../models/auth/grant.js';
import type { Db } from '../driver.js';
import { clientGrants } from '../schema.js';
import { isUniqueConstraintViolation } from '../sqliteErrors.js';
import { VersionConflict, versionedTableApplier, type EntityApplier } from '../effects.js';

export type ClientGrantsRepo = {
  findByDeviceCodeHash: (deviceCodeHash: string) => Promise<ClientGrantEntity | null>;
  findPendingByUserCode: (userCode: string) => Promise<ClientGrantEntity | null>;
  /** The newest sign-in this user actually completed for this client on this profile — the consent form's memory. */
  lastRedeemed: (userId: string, profile: string, clientName: string) => Promise<ClientGrantEntity | null>;
  /** Grants this user approved that no process has redeemed yet — each could still mint a sign-in as them. */
  listApprovedByUser: (userId: string) => Promise<ClientGrantEntity[]>;
  /** Every redeemed grant — candidates for `supersededGrants`, which decides which still matter. */
  listRedeemed: () => Promise<ClientGrantEntity[]>;
  /** Grants that ran out their window without being redeemed (`expiresAt` is ISO, so it sorts chronologically). */
  listExpired: (nowIso: string) => Promise<ClientGrantEntity[]>;
};

const findByDeviceCodeHash = async (
  db: Db,
  deviceCodeHash: string,
): ReturnType<ClientGrantsRepo['findByDeviceCodeHash']> => {
  const [row] = await db.select().from(clientGrants).where(eq(clientGrants.deviceCodeHash, deviceCodeHash)).limit(1);
  return row ? clientGrantAdapters.dbToModel(row) : null;
};

const findPendingByUserCode = async (
  db: Db,
  userCode: string,
): ReturnType<ClientGrantsRepo['findPendingByUserCode']> => {
  const [row] = await db
    .select()
    .from(clientGrants)
    .where(and(eq(clientGrants.userCode, userCode), eq(clientGrants.status, GrantStatus.enum.pending)))
    .limit(1);
  return row ? clientGrantAdapters.dbToModel(row) : null;
};

const lastRedeemed = async (
  db: Db,
  userId: string,
  profile: string,
  clientName: string,
): ReturnType<ClientGrantsRepo['lastRedeemed']> => {
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
    .orderBy(desc(clientGrants.approvedAt), desc(clientGrants.id))
    .limit(1);
  return row ? clientGrantAdapters.dbToModel(row) : null;
};

const listApprovedByUser = async (db: Db, userId: string): ReturnType<ClientGrantsRepo['listApprovedByUser']> => {
  const rows = await db
    .select()
    .from(clientGrants)
    .where(and(eq(clientGrants.userId, userId), eq(clientGrants.status, GrantStatus.enum.approved)));
  return rows.map(clientGrantAdapters.dbToModel);
};

const listRedeemed = async (db: Db): ReturnType<ClientGrantsRepo['listRedeemed']> => {
  const rows = await db.select().from(clientGrants).where(eq(clientGrants.status, GrantStatus.enum.redeemed));
  return rows.map(clientGrantAdapters.dbToModel);
};

const listExpired = async (db: Db, nowIso: string): ReturnType<ClientGrantsRepo['listExpired']> => {
  const rows = await db
    .select()
    .from(clientGrants)
    .where(and(lte(clientGrants.expiresAt, nowIso), ne(clientGrants.status, GrantStatus.enum.redeemed)));
  return rows.map(clientGrantAdapters.dbToModel);
};

export const clientGrantsRepo = (db: Db): ClientGrantsRepo => ({
  findByDeviceCodeHash: (deviceCodeHash) => findByDeviceCodeHash(db, deviceCodeHash),
  findPendingByUserCode: (userCode) => findPendingByUserCode(db, userCode),
  lastRedeemed: (userId, profile, clientName) => lastRedeemed(db, userId, profile, clientName),
  listApprovedByUser: (userId) => listApprovedByUser(db, userId),
  listRedeemed: () => listRedeemed(db),
  listExpired: (nowIso) => listExpired(db, nowIso),
});

const versionedClientGrantApplier = versionedTableApplier(clientGrants);

/** `user_code` is unique among PENDING grants: two grants drawing the same free code at once collide on that index,
 *  which `onConflictDoNothing` (scoped to `id`) does not swallow. Rethrown as `VersionConflict`, so the engine rolls
 *  back and re-runs `startGrant`, whose `freshUserCode` then sees the committed row and draws another code. */
export const clientGrantApplier: EntityApplier = {
  ...versionedClientGrantApplier,
  insert: async (tx, model, idempotencyKey) => {
    try {
      return await versionedClientGrantApplier.insert(tx, model, idempotencyKey);
    } catch (cause) {
      if (isUniqueConstraintViolation(cause)) throw new VersionConflict();
      throw cause;
    }
  },
};
