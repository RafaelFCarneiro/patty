import { AuthMode } from '../../models/auth.js';
import type { AuthDeps, Deps, RunEffects, RunEffectsSequence } from '../../controllers/deps.js';

/** Shared HTTP edge context (ADR-025) — built once in `routes.ts`, passed to every route module
 *  so a domain's routes don't each carry the full parameter list. */
export type HttpContext = {
  deps: Deps;
  version: string;
  runEffects: RunEffects;
  runEffectsSequence: RunEffectsSequence;
};

/** What the auth routes need (ADR-033): the identity deps, the shell's runner for their flows (already
 *  adapted model→row), and whether the session cookie is `Secure`. */
export type AuthRoutesContext = {
  deps: AuthDeps;
  runEffects: RunEffects;
  secureCookie: boolean;
};

/**
 * Whether the HTTP surface demands a session, with what the auth routes and the auth hook (composition
 * root, `src/authGate.ts`) need when it does. `disabled` (loopback default, ADR-033 §1) acts as the owner.
 */
export type HttpAuth =
  | { mode: typeof AuthMode.enum.disabled }
  | ({ mode: typeof AuthMode.enum.required; publicUrl?: string; sessionRecheckMs?: number } & AuthRoutesContext);

export const DISABLED_AUTH: HttpAuth = { mode: AuthMode.enum.disabled };
