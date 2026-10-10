import type { Principal, Scope } from '../../models/auth.js';

declare module 'fastify' {
  interface FastifyRequest {
    /** Who this request acts as — set by the auth hook (`diplomat/http/hooks/auth.ts`) before any handler runs.
     *  Absent only on the public routes (ADR-033 §6). */
    principal?: Principal;
  }

  interface FastifyContextConfig {
    /** The scope a caller needs for this route (`RouteDefinition.scope`), read by the auth hook. */
    scope?: Scope;
  }
}
