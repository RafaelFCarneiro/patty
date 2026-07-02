/**
 * Loopback-only bind host for the HTTP surface (sidecar and pure http mode). Deliberately
 * NOT '::' or '0.0.0.0': this API is unauthenticated (ADR-013 assumes local-first, no auth),
 * and binding the wildcard address makes it reachable from any device on the same LAN, not
 * just this machine — verified empirically, not just in theory.
 */
export const LOOPBACK_HOST = '127.0.0.1';

export const isPortInUse = (e: unknown): e is { code: string; port: number } =>
  typeof e === 'object' &&
  e !== null &&
  (e as { code?: string }).code === 'EADDRINUSE' &&
  typeof (e as { port?: unknown }).port === 'number';

/** Shared wording for both the fatal (pure http) and non-fatal (sidecar) EADDRINUSE messages. */
export const portInUseReason = (port: number): string =>
  `port ${port} is already in use (another service or MCP server is on it)`;
