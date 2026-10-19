import { z } from 'zod';
import { withPersistenceMeta } from '@rfc0/effect-runner';
import { Id } from '../id.js';
import { MINUTE_MS } from './time.js';

export const UserRole = z.enum(['admin', 'member']);
export type UserRole = z.infer<typeof UserRole>;

/** The owner is inserted by migration on every database (ADR-033 §7) — this id must match the
 *  `INSERT` in `drizzle/0018_auth_identity.sql`; `test/integration/db/ownerMigration.test.ts` pins it. */
export const OWNER_USER_ID = 'user-owner';

/** There is at most ONE setup code: issuing replaces it in place (ADR-033 §2), so concurrent starters can
 *  never leave two valid codes — the loser of the race retries into an update. */
export const SETUP_CODE_ID = 'setup-code';

export const SETUP_CODE_TTL_MS = 30 * MINUTE_MS;

export const SETUP_CODE_GROUP_SIZE = 4;
export const SETUP_CODE_GROUP_SEPARATOR = '-';
export const NON_ALPHANUMERIC = /[^A-Za-z0-9]/g;

/** Persistence-side user. `username`/`passwordHash` stay null until the owner is claimed (§7). */
export const UserEntitySchema = withPersistenceMeta(
  z.object({
    id: Id,
    username: z.string().nullable().describe('Normalized (trimmed, lower-cased) login name'),
    passwordHash: z.string().nullable().describe('argon2id PHC string'),
    role: UserRole,
    createdAt: z.string(),
    disabledAt: z.string().nullable(),
    lastLoginAt: z.string().nullable().describe('When this user last started a session — null until their first login'),
    credentialsChangedAt: z
      .string()
      .nullable()
      .describe('When this user’s set of ways in last changed — a credential was issued or ended; null if never'),
  }),
);
export type UserEntity = z.infer<typeof UserEntitySchema>;
export type ClaimedUserEntity = UserEntity & { username: string; passwordHash: string };

export const SetupCodeEntitySchema = withPersistenceMeta(
  z.object({
    id: Id,
    codeHash: z.string().describe('sha256 of the setup code — the code itself is never stored'),
    createdAt: z.string(),
    expiresAt: z.string(),
    usedAt: z.string().nullable(),
  }),
);
export type SetupCodeEntity = z.infer<typeof SetupCodeEntitySchema>;

export type ClaimedOwner = { username: string };

export type ClaimPlan = { kind: 'claim' } | { kind: 'skip'; username: string };

/** A setup code issued at startup — the plaintext goes to stderr once and nowhere else. */
export type IssuedSetupCode = { code: string; expiresAt: string };
