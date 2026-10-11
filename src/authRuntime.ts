import { randomUUID } from 'node:crypto';
import * as authAdapters from './adapters/auth.js';
import { formatAppError } from './common/errors.js';
import { McpTransport, type Config } from './config.js';
import { issueSetupCode, pruneExpiredSessions } from './controllers/auth.js';
import type { AuthDeps, RunEffects } from './controllers/deps.js';
import type { Db } from './diplomat/db/driver.js';
import type { ApplierRegistry } from './diplomat/db/effects.js';
import { accessTokenApplier, accessTokensRepo } from './diplomat/db/repos/accessTokens.js';
import { sessionApplier, sessionsRepo } from './diplomat/db/repos/sessions.js';
import { setupCodeApplier, setupCodesRepo } from './diplomat/db/repos/setupCodes.js';
import { userApplier, usersRepo } from './diplomat/db/repos/users.js';
import { SETUP_PATH } from './diplomat/http/authPaths.js';
import { DISABLED_AUTH, type HttpAuth } from './diplomat/http/context.js';
import { setupBanner } from './logic/auth.js';
import {
  ACCESS_TOKEN_ENTITY_TAG,
  AuthMode,
  SESSION_ENTITY_TAG,
  SETUP_CODE_ENTITY_TAG,
  USER_ENTITY_TAG,
} from './models/auth.js';

/**
 * Lazily imports the credential primitives so `@node-rs/argon2`'s native module is never loaded unless
 * an auth flow can run — an explicit `FINTRACK_AUTH=disabled` stdio run starts exactly as it did before ADR-033.
 */
const loadCredentialsModule = () => import('./diplomat/auth/credentials.js');

/** The auth flows touch four entities (user, session, setup code, access token) and the shell adapts model→row
 *  for each exactly once, here, before the generic runner sees the batch (docs/write-path.md § From model to row). */
export const bindAuthRunEffects =
  (runEffects: RunEffects): RunEffects =>
  (flow) =>
    runEffects(() => flow().map(authAdapters.outcomeToDb));

export const AUTH_APPLIERS: ApplierRegistry = {
  [USER_ENTITY_TAG]: userApplier,
  [SESSION_ENTITY_TAG]: sessionApplier,
  [ACCESS_TOKEN_ENTITY_TAG]: accessTokenApplier,
  [SETUP_CODE_ENTITY_TAG]: setupCodeApplier,
};

export const createAuthDeps = async (db: Db): Promise<AuthDeps> => {
  const { createSecrets } = await loadCredentialsModule();
  return {
    users: usersRepo(db),
    sessions: sessionsRepo(db),
    accessTokens: accessTokensRepo(db),
    setupCodes: setupCodesRepo(db),
    clock: () => new Date(),
    newId: () => randomUUID(),
    secrets: await createSecrets(),
  };
};

const isSecureOrigin = (publicUrl: string | undefined): boolean => publicUrl?.startsWith('https://') ?? false;

export type AuthConfig = Pick<
  Config,
  'FINTRACK_AUTH' | 'PUBLIC_URL' | 'HOST' | 'PORT' | 'MCP_TRANSPORT' | 'FINTRACK_HTTP'
>;

/** Whether anything will serve HTTP in this run — sessions only matter if so. */
export const httpSurfaceEnabled = (config: Pick<AuthConfig, 'MCP_TRANSPORT' | 'FINTRACK_HTTP'>): boolean =>
  config.MCP_TRANSPORT === McpTransport.enum.http || config.FINTRACK_HTTP;

/**
 * Composition-root step between `bootstrap` and the first listener (ADR-033): decides whether the HTTP
 * surface demands sessions and, when it does, builds the identity deps and prunes expired sessions. The one-time
 * setup code is NOT issued here but by `issueAndAnnounceSetup`, which `main.ts` calls only once a server has
 * actually bound — for two reasons. Issuing replaces the previous code in place, so a process that then fails to
 * bind (another stdio server already owns the port and has printed its own code) would invalidate the only code
 * an operator can see. And the banner needs a real URL (`PORT=0` is assigned at bind time).
 */
export type PreparedAuth = {
  auth: HttpAuth;
  /** While the owner is unclaimed, issue a fresh setup code and print it to STDERR (stdout carries stdio MCP),
   *  naming the origin the server really bound. A no-op once claimed, in `disabled` mode, or with no HTTP. */
  issueAndAnnounceSetup: (boundOrigin: string, announce?: (message: string) => void) => Promise<void>;
};

const NO_SETUP_TO_ISSUE: PreparedAuth['issueAndAnnounceSetup'] = async () => undefined;

export const prepareAuth = async (config: AuthConfig, db: Db, runEffects: RunEffects): Promise<PreparedAuth> => {
  if (config.FINTRACK_AUTH === AuthMode.enum.disabled || !httpSurfaceEnabled(config)) {
    return { auth: DISABLED_AUTH, issueAndAnnounceSetup: NO_SETUP_TO_ISSUE };
  }

  const deps = await createAuthDeps(db);
  const run = bindAuthRunEffects(runEffects);

  const pruned = await run(() => pruneExpiredSessions(deps));
  if (pruned.isErr()) throw new Error(`fintrack: could not prune expired sessions — ${formatAppError(pruned.error)}`);

  return {
    auth: {
      mode: AuthMode.enum.required,
      deps,
      runEffects: run,
      publicUrl: config.PUBLIC_URL,
      secureCookie: isSecureOrigin(config.PUBLIC_URL),
    },
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
