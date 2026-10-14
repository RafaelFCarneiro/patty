import { scopedFor, type Scoped, type Tenancy } from '../../controllers/deps.js';
import type { Principal } from '../../models/auth/principal.js';

/** Shared MCP edge context (ADR-025) — built once in `server.ts`, passed to every register module
 *  so a domain's tools/resources/prompts don't each carry the full parameter list. */
export type McpContext = {
  version: string;
  /** The user-scoped dependencies of whoever is calling (ADR-033 §5). A callback asks for them with the request's own
   *  `extra`; there is no unscoped alternative on this context. */
  as: (extra: unknown) => Scoped;
};

/** What the scope guard (`scopes.ts`) puts on a callback's request context once the gate has granted the caller:
 *  the principal it authenticated. */
export type CallerExtra = { principal: Principal };

export const MISSING_CALLER_MESSAGE = 'fintrack: an MCP callback reached user data without an authenticated principal';

/** The principal a granted request carries — and a failure, never a default, for one that has none: a callback that
 *  reaches user data unauthenticated is a bug, and it must not fall back to anyone. */
export const callerOf = (extra: unknown): Principal => {
  const principal = (extra as Partial<CallerExtra> | undefined)?.principal;
  if (principal === undefined) throw new Error(MISSING_CALLER_MESSAGE);
  return principal;
};

export const createMcpContext = (tenancy: Tenancy, version: string): McpContext => ({
  version,
  as: (extra) => scopedFor(tenancy, callerOf(extra)),
});
