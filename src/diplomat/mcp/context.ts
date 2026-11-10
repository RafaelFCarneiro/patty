import { scopedFor, type Scoped, type Tenancy } from '../../controllers/deps.js';
import type { Principal } from '../../models/auth/principal.js';
import { LOG_PREFIX } from '../../models/package.js';

/** Shared MCP edge context (ADR-025) — built once in `server.ts`, passed to every register module
 *  so a domain's tools/resources/prompts don't each carry the full parameter list. */
export type McpContext = {
  version: string;
  as: (extra: unknown) => Scoped;
};

export type CallerExtra = { principal: Principal };

export const MISSING_CALLER_MESSAGE = `${LOG_PREFIX} an MCP callback reached user data without an authenticated principal`;

/** Throws without a principal rather than defaulting to anyone. */
export const callerOf = (extra: unknown): Principal => {
  const principal = (extra as Partial<CallerExtra> | undefined)?.principal;
  if (principal === undefined) throw new Error(MISSING_CALLER_MESSAGE);
  return principal;
};

export const createMcpContext = (tenancy: Tenancy, version: string): McpContext => ({
  version,
  as: (extra) => scopedFor(tenancy, callerOf(extra)),
});
