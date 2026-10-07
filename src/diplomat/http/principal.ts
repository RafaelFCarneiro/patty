import type { FastifyRequest } from 'fastify';
import type { Principal } from '../../models/auth.js';

declare module 'fastify' {
  interface FastifyRequest {
    /** Who this request acts as — set by the auth hook (`src/authGate.ts`) before any handler runs.
     *  Absent only on the public routes (ADR-033 §6). */
    principal?: Principal;
  }
}

export const principalOf = (req: FastifyRequest): Principal | undefined => req.principal;
