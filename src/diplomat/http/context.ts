import { AuthMode } from '../../models/auth/mode.js';
import type { AuthDeps, Deps, RunEffects, Tenancy } from '../../controllers/deps.js';

/** Shared HTTP edge context (ADR-025) — built once in `routes.ts`. A route module needing only the user's own
 *  dependencies takes no context at all: its handlers ask for them per request (`ScopeOf`, `openapi.ts`). What is
 *  here is what a request's user cannot change: the version, the factories that build a user's dependencies, and the
 *  unauthenticated probe's. */
export type HttpContext = Tenancy & {
  version: string;
  /** The health probe's dependencies — no user's. */
  publicDeps: Pick<Deps, 'health'>;
};

const DOCUMENTATION_ONLY = (): never => {
  throw new Error('fintrack: this HTTP context only documents the routes (OpenAPI) — it serves none');
};

/** A context for building the route list to DOCUMENT it (`fintrack://openapi`, which has no HTTP request and so no
 *  principal): the handlers are never invoked, and any attempt to would fail rather than reach a user's data. */
export const documentationContext = (version: string): HttpContext => ({
  version,
  publicDeps: { health: { reachable: DOCUMENTATION_ONLY } },
  depsFor: DOCUMENTATION_ONLY,
  runEffectsFor: DOCUMENTATION_ONLY,
  runEffectsSequenceFor: DOCUMENTATION_ONLY,
  resetLocaleFor: DOCUMENTATION_ONLY,
});

/** What the auth routes need (ADR-033): the identity deps, the shell's runner for their flows (already
 *  adapted model→row), and whether the session cookie is `Secure`. */
export type AuthRoutesContext = {
  deps: AuthDeps;
  runEffects: RunEffects;
  secureCookie: boolean;
};

/**
 * Whether the HTTP surface demands a session, with what the auth routes and the auth hook
 * (`hooks/auth.ts`) need when it does. `disabled` (loopback default, ADR-033 §1) acts as the owner.
 */
export type HttpAuth =
  | { mode: typeof AuthMode.enum.disabled }
  | ({ mode: typeof AuthMode.enum.required; publicUrl?: string; sessionRecheckMs?: number } & AuthRoutesContext);

export const DISABLED_AUTH: HttpAuth = { mode: AuthMode.enum.disabled };
