import { z } from 'zod';
import { withPersistenceMeta } from '@rfc0/effect-runner';
import { Id } from '../id.js';
import { LoginDuration, type ClientGrantEntity } from './grant.js';
import type { UserRole, UserEntity } from './owner.js';
import type { Principal } from './principal.js';
import { HOUR_MS } from './time.js';
import type { SessionEntity } from './session.js';
import type { AccessTokenEntity } from './token.js';

/** How long an invite link stays usable. After that an admin issues a new one. */
export const INVITE_TTL_HOURS = 72;
export const INVITE_TTL_MS = INVITE_TTL_HOURS * HOUR_MS;

/**
 * The longest a stdio sign-in may last on this instance. Only the saved durations are offered as a cap: "this session
 * only" is always shorter than any of them, so it is never above the cap.
 */
export const SignInCap = LoginDuration;
export type SignInCap = z.infer<typeof SignInCap>;
export const DEFAULT_SIGN_IN_CAP = SignInCap.enum['30d'];

/** The `settings` table holds one instance-wide row. */
export const INSTANCE_SETTINGS_ID = 'singleton';

export const InstanceSettingsEntitySchema = withPersistenceMeta(z.object({ id: Id, maxSignInDuration: SignInCap }));
export type InstanceSettingsEntity = z.infer<typeof InstanceSettingsEntitySchema>;

/** An invitation to claim one unclaimed user row. Only the code's sha256 is stored. */
export const InviteEntitySchema = withPersistenceMeta(
  z.object({
    id: Id,
    userId: Id.describe('The invited user: the row the claim updates'),
    codeHash: z.string().describe('sha256 of the normalized invite code — the code itself is never stored'),
    createdBy: Id.nullable().describe('The admin who issued it; null when the trusted terminal did'),
    createdAt: z.string(),
    expiresAt: z.string(),
    usedAt: z.string().nullable(),
  }),
);
export type InviteEntity = z.infer<typeof InviteEntitySchema>;

/** The actions a row of the users page offers on one user: the last segment of each action's URL. */
export const UserAction = z.enum(['reissue', 'disable', 'enable', 'role']);
export type UserAction = z.infer<typeof UserAction>;

/** The actions that can take an active admin away. */
export const AdminChange = z.enum(['disable', 'demote', 'reissue']);
export type AdminChange = z.infer<typeof AdminChange>;

export const UserStatus = z.enum(['invited', 'active', 'disabled']);
export type UserStatus = z.infer<typeof UserStatus>;

/** A user as the management list shows them — never a hash. */
export type UserSummary = {
  id: string;
  username: string | null;
  role: UserRole;
  status: UserStatus;
  createdAt: string;
  lastLoginAt: string | null;
  /** When the invite that is still waiting to be claimed runs out; null if none is waiting. */
  inviteExpiresAt: string | null;
};

/**
 * Who is asking for a user-management action. A browser admin acts through a session (and re-types their password for
 * the actions that ask for it); the terminal is the trusted local operator: it holds the database key, so it has no
 * session, no user and no step-up.
 */
export const ActorKind = z.enum(['terminal', 'session']);
export type ActorKind = z.infer<typeof ActorKind>;

export type Actor =
  | { kind: typeof ActorKind.enum.terminal }
  | {
      kind: typeof ActorKind.enum.session;
      principal: Principal;
      /** The step-up password, for the actions that ask for it. */ password?: string;
    };

export type InviteUserInput = { username: string; role: UserRole };

/** A freshly issued invite — the plaintext code is shown once and never stored or logged. */
export type IssuedInvite = {
  user: UserSummary;
  code: string;
  expiresAt: string;
  /** What a reissue ended for a user who had already claimed — zeros for a first invite. */
  revoked: RevokedCredentials;
};

export type ClaimInviteInput = { code: string; password: string };

export type SetRoleInput = { userId: string; role: UserRole };

export type SetSignInCapInput = { maxSignInDuration: SignInCap };

/** Whose credentials an action ended, for the report to the admin. */
export type RevokedCredentials = { sessionsEnded: number; tokensRevoked: number };

export type UserChange = { user: UserSummary; revoked: RevokedCredentials };

export type Admitted = {
  actingUserId: string | null;
  acting: UserEntity | null;
  session: SessionEntity | null;
};

export type HeldCredentials = {
  sessions: readonly SessionEntity[];
  tokens: readonly AccessTokenEntity[];
  approvedGrants: readonly ClientGrantEntity[];
};

export const CHANGE_BLOCKS_SELF: Readonly<Record<AdminChange, boolean>> = {
  [AdminChange.enum.disable]: true,
  [AdminChange.enum.demote]: true,
  [AdminChange.enum.reissue]: false,
};

export type UserPlan = {
  userWrites: UserEntity[];
  checks: UserEntity[];
  sessions: SessionEntity[];
  tokens: AccessTokenEntity[];
  expiredGrants: ClientGrantEntity[];
  removedInvites: InviteEntity[];
  newInvites: Omit<InviteEntity, 'version'>[];
  after: UserEntity;
  revoked: RevokedCredentials;
};

export type UserPlanFacts = {
  actingUserId: string | null;
  acting: UserEntity | null;
  target: UserEntity;
  users: readonly UserEntity[];
  now: Date;
};

export const NO_REVOCATIONS: RevokedCredentials = { sessionsEnded: 0, tokensRevoked: 0 };
