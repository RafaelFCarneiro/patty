import type { Deps, RunEffects, RunEffectsSequence } from '../../controllers/deps.js';

/** Shared MCP edge context (ADR-025) — built once in `server.ts`, passed to every register module
 *  so a domain's tools/resources/prompts don't each carry the full parameter list. */
export type McpContext = {
  deps: Deps;
  version: string;
  runEffects: RunEffects;
  runEffectsSequence: RunEffectsSequence;
  resetLocale: () => void;
};
