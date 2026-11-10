import { z } from 'zod';
import { authErrors } from '../../models/auth/errors.js';
import { OWNER_PRINCIPAL, type Principal } from '../../models/auth/principal.js';
import type { AppError } from '../../common/errors.js';
import { principalOf } from './auth-info.js';

export const GateKind = z.enum(['granted', 'refused', 'not_signed_in']);

/**
 * Who a tool call, resource read or prompt get acts as, per transport (ADR-034 §4). The scope guard asks its
 * `PrincipalGate` once per request and never learns how the answer was reached:
 *   - HTTP rebuilds the principal the edge attached (`extra.authInfo`), failing closed when it is absent or malformed;
 *   - stdio asks its `StdioSession`, which re-validates the saved credential on every call;
 *   - an explicit `PATTY_AUTH=disabled` run is the trusted owner.
 * A grant carries the WHOLE principal (user, role, scopes, how it authenticated), on every transport, so a handler
 * that needs to know who is calling (per-user data, ADR-033 Phase 4) can read it from one place.
 */
export type GateOutcome =
  | { kind: typeof GateKind.enum.granted; principal: Principal }
  /** The caller is known but may not do this (or is unknown, over HTTP): the structured auth error. */
  | { kind: typeof GateKind.enum.refused; error: AppError }
  /** Nobody is signed in: the one-line, secret-free instructions to do so (stdio only). */
  | { kind: typeof GateKind.enum.not_signed_in; message: string };

export type PrincipalGate = (extra: unknown) => Promise<GateOutcome>;

type AuthExtra = { authInfo?: Parameters<typeof principalOf>[0] } | undefined;

/** HTTP: the edge authenticated the request and handed the principal to the transport as `req.auth`. */
export const authInfoGate: PrincipalGate = async (extra) => {
  const authInfo = (extra as AuthExtra)?.authInfo;
  const principal = authInfo === undefined ? null : principalOf(authInfo);
  return principal === null
    ? { kind: GateKind.enum.refused, error: authErrors.unauthenticated }
    : { kind: GateKind.enum.granted, principal };
};

/** `PATTY_AUTH=disabled`: every request is the owner, holding every scope. */
export const ownerGate: PrincipalGate = async () => ({ kind: GateKind.enum.granted, principal: OWNER_PRINCIPAL });
