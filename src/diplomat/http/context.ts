import { AuthMode } from '../../models/auth/mode.js';
import type { AuthDeps, Deps, RunEffects, Tenancy } from '../../controllers/deps.js';

/** Shared HTTP edge context, built once in `routes.ts`; per-user dependencies are asked for per request instead. */
export type HttpContext = Tenancy & {
  version: string;
  publicDeps: Pick<Deps, 'health'>;
};

const DOCUMENTATION_ONLY = (): never => {
  throw new Error('fintrack: this HTTP context only documents the routes (OpenAPI) — it serves none');
};

/** Builds the route list for documentation only (no request, no principal); handlers must never run. */
export const documentationContext = (version: string): HttpContext => ({
  version,
  publicDeps: { health: { reachable: DOCUMENTATION_ONLY } },
  instanceKind: DOCUMENTATION_ONLY,
  instanceLocale: DOCUMENTATION_ONLY,
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
  /** The external origin, when one is configured — the invite link names it. */
  publicUrl?: string;
};

/**
 * Whether the HTTP surface demands a session, with what the auth routes and the auth hook
 * (`hooks/auth.ts`) need when it does. `disabled` (loopback default, ADR-033 §1) acts as the owner.
 */
export type HttpAuth =
  | { mode: typeof AuthMode.enum.disabled }
  | ({ mode: typeof AuthMode.enum.required; publicUrl?: string; sessionRecheckMs?: number } & AuthRoutesContext);

export const DISABLED_AUTH: HttpAuth = { mode: AuthMode.enum.disabled };
