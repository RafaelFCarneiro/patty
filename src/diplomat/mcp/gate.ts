import { z } from 'zod';
import { ALL_SCOPES, authErrors } from '../../models/auth.js';
import type { AppError } from '../../common/errors.js';

export const GateKind = z.enum(['granted', 'refused', 'not_signed_in']);

/**
 * Who a tool call, resource read or prompt get acts as, per transport (ADR-034 §4). The scope guard asks its
 * `PrincipalGate` once per request and never learns how the answer was reached:
 *   - HTTP reads the principal the edge attached (`extra.authInfo`), failing closed when it is absent;
 *   - stdio asks its `StdioSession`, which re-validates the saved credential on every call;
 *   - an explicit `FINTRACK_AUTH=disabled` run is the trusted owner.
 */
export type GateOutcome =
  | { kind: typeof GateKind.enum.granted; scopes: readonly string[] }
  /** The caller is known but may not do this (or is unknown, over HTTP): the structured auth error. */
  | { kind: typeof GateKind.enum.refused; error: AppError }
  /** Nobody is signed in: the one-line, secret-free instructions to do so (stdio only). */
  | { kind: typeof GateKind.enum.not_signed_in; message: string };

export type PrincipalGate = (extra: unknown) => Promise<GateOutcome>;

type AuthExtra = { authInfo?: { scopes: string[] } } | undefined;

/** HTTP: the edge authenticated the request and handed the principal to the transport as `req.auth`. */
export const authInfoGate: PrincipalGate = async (extra) => {
  const authInfo = (extra as AuthExtra)?.authInfo;
  return authInfo === undefined
    ? { kind: GateKind.enum.refused, error: authErrors.unauthenticated }
    : { kind: GateKind.enum.granted, scopes: authInfo.scopes };
};

/** `FINTRACK_AUTH=disabled`: every request is the owner, holding every scope. */
export const ownerGate: PrincipalGate = async () => ({ kind: GateKind.enum.granted, scopes: ALL_SCOPES });
