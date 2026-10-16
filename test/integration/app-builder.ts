import { createRequire } from 'node:module';
import type { FastifyInstance } from 'fastify';
import { inject } from 'vitest';
import { bootstrap } from '../../src/diplomat/db/bootstrap.js';
import { openDatabase } from '../../src/diplomat/db/driver.js';
import { httpOrigin } from '../../src/common/net.js';
import { prepareAuth, type AuthConfig } from '../../src/composition/auth.js';
import { createRuntime, type Runtime } from '../../src/composition/runtime.js';
import type { HttpAuth } from '../../src/diplomat/http/context.js';
import { DISABLED_AUTH } from '../../src/diplomat/http/context.js';
import { buildHttpApp, registerHttpApp } from '../../src/composition/http.js';
import { AuthMode } from '../../src/models/auth/mode.js';
import { OWNER_PRINCIPAL, type Principal } from '../../src/models/auth/principal.js';
import type { ChangeBus } from '@rfc0/effect-runner';
import type { ChangeEvent } from '../../src/models/tenancy.js';
import type { Db } from '../../src/diplomat/db/driver.js';
import {
  scopedFor,
  type Deps,
  type RunEffects,
  type RunEffectsSequence,
  type Scoped,
} from '../../src/controllers/deps.js';

const TEST_ENCRYPTION_KEY = 'a'.repeat(64);

export type AppContext = {
  app: FastifyInstance;
  /** The owner's scoped dependencies and runners — what every pre-tenancy test used (the owner is the one user). */
  deps: Deps;
  version: string;
  runEffects: RunEffects;
  runEffectsSequence: RunEffectsSequence;
  changeBus: ChangeBus<ChangeEvent>;
  /** Runs the identity flows (users, sessions, tokens…) — unscoped, as the composition root does. */
  authRunEffects: RunEffects;
  runtime: Runtime;
  /** The scoped dependencies and runners of any principal (the second user of an isolation test, say). */
  scopedAs: (principal: Pick<Principal, 'userId'> & Partial<Principal>) => Scoped;
  /** Pins the time every request reads; returns the function that puts the previous clock back. */
  setClock: (clock: () => Date) => () => void;
  db: Db;
  /** Wire the same deps/auth onto another Fastify instance (a test that must hook it before routes exist). */
  registerOn: (app: FastifyInstance) => void;
  auth: HttpAuth;
  /** Everything startup printed to stderr — the setup-code banner, in auth-required mode. */
  announced: string[];
};

/** Auth `required` on a loopback bind with the sidecar on — what a container behind a proxy runs. */
export const REQUIRED_AUTH: AuthConfig = {
  FINTRACK_AUTH: AuthMode.enum.required,
  PUBLIC_URL: undefined,
  HOST: '127.0.0.1',
  PORT: 51737,
  MCP_TRANSPORT: 'http',
  FINTRACK_HTTP: true,
  // Only a stdio sign-in's temporary page reads these; the app builder never serves one.
  DB_PATH: '/nonexistent/fintrack.db',
  TRUST_PROXY: undefined,
  FINTRACK_LOCALE: undefined,
  FIAT_RATE_STALE_HOURS: 24,
  CRYPTO_RATE_STALE_HOURS: 1,
};

export const buildApp = async (opts?: {
  port?: number;
  dbPath?: string;
  onChangeError?: (cause: unknown) => void;
  /** Present → sessions are required (ADR-033); omitted → auth disabled, exactly the pre-auth behavior. */
  auth?: Partial<AuthConfig>;
  /** How often an open /ui/events stream re-checks its session (default 30 s; tests shorten it). */
  sessionRecheckMs?: number;
}): Promise<AppContext> => {
  const db = await openDatabase({
    DB_PATH: opts?.dbPath ?? (inject('DB_PATH' as never) as string),
    FINTRACK_DB_KEY: TEST_ENCRYPTION_KEY,
  });

  await bootstrap(db);

  let now: () => Date = () => new Date();
  const setClock: AppContext['setClock'] = (clock) => {
    const previous = now;
    now = clock;
    return () => {
      now = previous;
    };
  };
  const runtime = createRuntime(
    db,
    { FINTRACK_LOCALE: undefined, FIAT_RATE_STALE_HOURS: 24, CRYPTO_RATE_STALE_HOURS: 1 },
    { onChangeError: opts?.onChangeError, clock: () => now() },
  );
  const scopedAs: AppContext['scopedAs'] = (principal) => scopedFor(runtime, { ...OWNER_PRINCIPAL, ...principal });
  const owner = scopedAs(OWNER_PRINCIPAL);

  const require = createRequire(import.meta.url);
  const { version } = require('../../package.json') as { version: string };

  const announced: string[] = [];
  const authConfig: AuthConfig = { ...REQUIRED_AUTH, ...opts?.auth };
  const prepared = opts?.auth
    ? await prepareAuth(authConfig, db, runtime.authRunEffects)
    : { auth: DISABLED_AUTH, issueAndAnnounceSetup: async () => undefined };
  // As a real start does once its server has bound: issue and print the setup code, to the captured stderr.
  await prepared.issueAndAnnounceSetup(httpOrigin(authConfig.HOST, authConfig.PORT), (message) =>
    announced.push(message),
  );
  const auth: HttpAuth =
    prepared.auth.mode === AuthMode.enum.required
      ? { ...prepared.auth, sessionRecheckMs: opts?.sessionRecheckMs }
      : prepared.auth;
  const app = buildHttpApp(runtime, version, { logger: false, auth });
  const registerOn = (other: FastifyInstance): void => registerHttpApp(other, runtime, version, auth);

  return {
    app,
    db,
    registerOn,
    auth,
    announced,
    deps: owner.deps,
    version,
    runEffects: owner.runEffects,
    runEffectsSequence: owner.runEffectsSequence,
    changeBus: runtime.changeBus,
    authRunEffects: runtime.authRunEffects,
    runtime,
    scopedAs,
    setClock,
  };
};
