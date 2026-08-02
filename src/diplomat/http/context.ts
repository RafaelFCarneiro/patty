import type { Deps, RunEffects, RunEffectsSequence } from '../../controllers/deps.js';

/** Shared HTTP edge context (ADR-025) — built once in `routes.ts`, passed to every route module
 *  so a domain's routes don't each carry the full parameter list. */
export type HttpContext = {
  deps: Deps;
  version: string;
  runEffects: RunEffects;
  runEffectsSequence: RunEffectsSequence;
};
