import { randomUUID } from 'node:crypto';
import * as authAdapters from '../adapters/auth.js';
import { formatAppError } from '../common/errors.js';
import { McpTransport, type Config } from '../config.js';
import { issueSetupCode, pruneExpiredSessions } from '../controllers/auth.js';
import { pruneExpiredGrants } from '../controllers/grants.js';
import { pruneExpiredInvites } from '../controllers/users.js';
import type { AuthDeps, RunEffects, SignInInterpreter } from '../controllers/deps.js';
import type { RuntimeConfig } from './runtime.js';
import { createSignInFor } from './sign-in/wiring.js';
import type { Db } from '../diplomat/db/driver.js';
import type { ApplierRegistry } from '../diplomat/db/effects.js';
import { accessTokenApplier, accessTokensRepo } from '../diplomat/db/repos/access-tokens.js';
import { clientGrantApplier, clientGrantsRepo } from '../diplomat/db/repos/client-grants.js';
import { instanceSettingsApplier, instanceSettingsRepo } from '../diplomat/db/repos/instance-settings.js';
import { inviteApplier, invitesRepo } from '../diplomat/db/repos/invites.js';
import { sessionApplier, sessionsRepo } from '../diplomat/db/repos/sessions.js';
import { setupCodeApplier, setupCodesRepo } from '../diplomat/db/repos/setup-codes.js';
import { userApplier, usersRepo } from '../diplomat/db/repos/users.js';
import { SETUP_PATH } from '../diplomat/http/auth-paths.js';
import { DISABLED_AUTH, type HttpAuth } from '../diplomat/http/context.js';
import { setupBanner } from '../logic/auth/message.js';
import {
  ACCESS_TOKEN_ENTITY_TAG,
  CLIENT_GRANT_ENTITY_TAG,
  INSTANCE_SETTINGS_ENTITY_TAG,
  INVITE_ENTITY_TAG,
  SESSION_ENTITY_TAG,
  SETUP_CODE_ENTITY_TAG,
  USER_ENTITY_TAG,
} from '../models/auth/entity.js';
import { AuthMode } from '../models/auth/mode.js';

/**
 * Lazily imports the credential primitives so `@node-rs/argon2`'s native module is never loaded unless
 * an auth flow can run — an explicit `FINTRACK_AUTH=disabled` stdio run starts exactly as it did before ADR-033.
 */
const loadCredentialsModule = () => import('../diplomat/auth/credentials.js');

/** The auth flows touch seven entities (user, session, setup code, access token, client grant, invite, instance
 *  settings) and the shell
 *  adapts model→row for each exactly once, here, before the generic runner sees the batch
 *  (docs/write-path.md § From model to row). */
export const bindAuthRunEffects =
  (runEffects: RunEffects): RunEffects =>
  (flow) =>
    runEffects(() => flow().map(authAdapters.outcomeToDb));

export const AUTH_APPLIERS: ApplierRegistry = {
  [USER_ENTITY_TAG]: userApplier,
  [SESSION_ENTITY_TAG]: sessionApplier,
  [ACCESS_TOKEN_ENTITY_TAG]: accessTokenApplier,
  [CLIENT_GRANT_ENTITY_TAG]: clientGrantApplier,
  [SETUP_CODE_ENTITY_TAG]: setupCodeApplier,
  [INVITE_ENTITY_TAG]: inviteApplier,
  [INSTANCE_SETTINGS_ENTITY_TAG]: instanceSettingsApplier,
};

export const createAuthDeps = async (db: Db): Promise<AuthDeps> => {
  const { createSecrets } = await loadCredentialsModule();
  return {
    users: usersRepo(db),
    sessions: sessionsRepo(db),
    accessTokens: accessTokensRepo(db),
    clientGrants: clientGrantsRepo(db),
    invites: invitesRepo(db),
    instanceSettings: instanceSettingsRepo(db),
    setupCodes: setupCodesRepo(db),
    clock: () => new Date(),
    newId: () => randomUUID(),
    secrets: await createSecrets(),
  };
};

const isSecureOrigin = (publicUrl: string | undefined): boolean => publicUrl?.startsWith('https://') ?? false;

/** What auth needs of the config — including what a sign-in needs to serve its temporary page on this database. */
export type AuthConfig = Pick<
  Config,
  | 'FINTRACK_AUTH'
  | 'PUBLIC_URL'
  | 'HOST'
  | 'PORT'
  | 'MCP_TRANSPORT'
  | 'FINTRACK_HTTP'
  | 'DB_PATH'
  | 'TRUST_PROXY'
  | keyof RuntimeConfig
>;

/** Whether anything will serve HTTP in this run — sessions only matter if so. */
export const httpSurfaceEnabled = (config: Pick<AuthConfig, 'MCP_TRANSPORT' | 'FINTRACK_HTTP'>): boolean =>
  config.MCP_TRANSPORT === McpTransport.enum.http || config.FINTRACK_HTTP;

/**
 * Composition-root step between `bootstrap` and the first listener (ADR-033, ADR-034): decides whether anything
 * demands a login and, when it does, builds the identity deps and prunes expired sessions and sign-in requests. The
 * one-time setup code is NOT issued here but by `issueAndAnnounceSetup`, which `main.ts` calls only once a server has
 * actually bound — for two reasons. Issuing replaces the previous code in place, so a process that then fails to
 * bind (another stdio server already owns the port and has printed its own code) would invalidate the only code
 * an operator can see. And the banner needs a real URL (`PORT=0` is assigned at bind time).
 */
export type PreparedAuth = {
  auth: HttpAuth;
  /** What the stdio channel signs in with: the sign-in interpreter of a profile, given the origin of the page this
   *  process can name (the bound sidecar's, or none). Present whenever authentication is required and the
   *  transport is stdio — even with `FINTRACK_HTTP=false`, where there is no HTTP surface but the stdio session
   *  still needs a login. */
  stdio: { signIn: (profile: string, origin: () => string | null) => SignInInterpreter } | null;
  /** While the owner is unclaimed, issue a fresh setup code and print it to STDERR (stdout carries stdio MCP),
   *  naming the origin the server really bound. A no-op once claimed, in `disabled` mode, or with no HTTP. */
  issueAndAnnounceSetup: (boundOrigin: string, announce?: (message: string) => void) => Promise<void>;
};

const NO_SETUP_TO_ISSUE: PreparedAuth['issueAndAnnounceSetup'] = async () => undefined;

const housekeeping = async (run: RunEffects, deps: AuthDeps): Promise<void> => {
  const sessions = await run(() => pruneExpiredSessions(deps));
  if (sessions.isErr())
    throw new Error(`fintrack: could not prune expired sessions — ${formatAppError(sessions.error)}`);
  const grants = await run(() => pruneExpiredGrants(deps));
  if (grants.isErr()) throw new Error(`fintrack: could not prune expired sign-ins — ${formatAppError(grants.error)}`);
  const invites = await run(() => pruneExpiredInvites(deps));
  if (invites.isErr()) throw new Error(`fintrack: could not prune expired invites — ${formatAppError(invites.error)}`);
};

export const prepareAuth = async (config: AuthConfig, db: Db, runEffects: RunEffects): Promise<PreparedAuth> => {
  if (config.FINTRACK_AUTH === AuthMode.enum.disabled) {
    return { auth: DISABLED_AUTH, stdio: null, issueAndAnnounceSetup: NO_SETUP_TO_ISSUE };
  }

  const deps = await createAuthDeps(db);
  const run = bindAuthRunEffects(runEffects);
  await housekeeping(run, deps);

  const stdio: PreparedAuth['stdio'] =
    config.MCP_TRANSPORT === McpTransport.enum.stdio
      ? {
          signIn: (profile, origin) =>
            createSignInFor({ config, db, deps, run }, { profile, origin, canServePage: config.FINTRACK_HTTP }),
        }
      : null;
  if (!httpSurfaceEnabled(config)) return { auth: DISABLED_AUTH, stdio, issueAndAnnounceSetup: NO_SETUP_TO_ISSUE };

  return {
    auth: {
      mode: AuthMode.enum.required,
      deps,
      runEffects: run,
      publicUrl: config.PUBLIC_URL,
      secureCookie: isSecureOrigin(config.PUBLIC_URL),
    },
    stdio,
    issueAndAnnounceSetup: async (boundOrigin, announce = console.error) => {
      const issued = await run(() => issueSetupCode(deps, config.FINTRACK_AUTH));
      if (issued.isErr()) throw new Error(`fintrack: could not issue a setup code — ${formatAppError(issued.error)}`);
      const code = issued.value;
      if (!code) return;
      const origin = config.PUBLIC_URL ?? boundOrigin;
      announce(setupBanner({ code: code.code, setupUrl: `${origin}${SETUP_PATH}`, expiresAt: code.expiresAt }));
    },
  };
};
