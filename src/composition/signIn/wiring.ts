import type { AuthConfig } from '../auth.js';
import type { AuthDeps, RunEffects, SignInInterpreter } from '../../controllers/deps.js';
import { keychainSignInStore } from '../../diplomat/auth/signInStore.js';
import type { Db } from '../../diplomat/db/driver.js';
import { dbIdOf, keychainAccount } from '../../logic/auth/keychain.js';
import { createSignInInterpreter } from './interpreter.js';

/** Lazy: Fastify and the route table load only when a sign-in actually has to serve the consent page. */
const loadSignInServerModule = () => import('./server.js');

/**
 * Composition root: the sign-in interpreter for one profile of this database. The one place that derives the keychain
 * account (profile + the database it belongs to), opens the keychain store and knows how to serve a temporary
 * `/ui/connect` page — `composition/auth.ts` (stdio) and `composition/cli.ts` (`login`/`logout`) differ only in
 * what they pass.
 */
export const createSignInFor = (
  world: { config: AuthConfig; db: Db; deps: AuthDeps; run: RunEffects },
  options: {
    profile: string;
    /** The origin of a page this process can already name, or `null`. */
    origin: () => string | null;
    /** Whether a temporary page may be served when `origin()` names none. */
    canServePage: boolean;
  },
): SignInInterpreter => {
  const { config, db, deps, run } = world;
  return createSignInInterpreter({
    deps,
    run,
    store: keychainSignInStore(keychainAccount(options.profile, dbIdOf(deps.secrets.hashSecret(config.DB_PATH)))),
    origin: options.origin,
    startPage: options.canServePage
      ? async () => (await loadSignInServerModule()).startSignInServer(config, db)
      : undefined,
  });
};
